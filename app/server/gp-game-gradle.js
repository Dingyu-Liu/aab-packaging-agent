import { isAbsolute, relative, resolve, basename } from "node:path";
import { pathToFileURL } from "node:url";
const GAME_ANDROID = Object.freeze({ compileSdk: 36, targetSdk: 36, minSdk: 24, buildTools: "36.1.0", ndk: "29.0.14206865" });
function gradleMask(text) {
  return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|'''[\s\S]*?'''|"""[\s\S]*?"""|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, (value) => value.replace(/[^\n]/g, " "));
}
function gradleBlocks(text) {
  const mask = gradleMask(text), result = [], stack = [];
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === "{") {
      const match = /([\w.]+)\s*(?:\([^{}]*\))?\s*$/.exec(mask.slice(0, i));
      const block = { name: match?.[1] || "", start: match ? i - match[0].length : i, open: i, end: text.length, parent: stack.at(-1) };
      result.push(block);
      stack.push(block);
    } else if (mask[i] === "}") {
      const block = stack.pop();
      if (block) block.end = i + 1;
    }
  }
  return result;
}
function groovy(value) {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\r/g, "\\r").replace(/\n/g, "\\n")}'`;
}
function gradleLiteral(body, name) {
  const mask = gradleMask(body), expression = new RegExp(`\\b${name}\\s*(?:=\\s*)?(['"])((?:\\\\.|[^\\\\])*?)\\1`, "g");
  for (const match of body.matchAll(expression)) {
    if (!mask.slice(match.index, match.index + name.length).trim()) continue;
    const value = match[2].replace(/\\(['"\\])/g, "$1");
    if (match[1] === '"' && value.includes("$")) return void 0;
    return value;
  }
}
function setValue(body, name, value, rememberOld = false) {
  const mask = gradleMask(body), changes = [];
  for (const match of mask.matchAll(new RegExp(`\\b${name}\\b`, "g"))) {
    const start = match.index, afterName = start + name.length;
    const valueStart = afterName + (/^[ \t]*(?:=[ \t]*)?/.exec(body.slice(afterName))?.[0].length || 0);
    const prefix = mask.slice(0, start).trimEnd();
    if (prefix && !/[;{}]$/.test(prefix) && mask.slice(mask.lastIndexOf("\n", start) + 1, start).trim()) continue;
    if (!body[valueStart] || /[\r\n{]/.test(body[valueStart])) continue;
    const literal = /^(?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")/.exec(body.slice(valueStart));
    let end = literal ? valueStart + literal[0].length : valueStart;
    if (!literal) {
      let depth = 0;
      while (end < mask.length) {
        if (depth === 0 && /[;\r\n}]/.test(mask[end])) break;
        if (mask[end] === "(" || mask[end] === "[") depth++;
        if (mask[end] === ")" || mask[end] === "]") depth--;
        end++;
      }
      while (end > valueStart && /\s/.test(body[end - 1])) end--;
    }
    const statement = body.slice(start, end), next = `${name} ${value}`;
    if (statement === next) {
      changes.push({ start, end, replacement: statement });
      continue;
    }
    const lineStart = body.lastIndexOf("\n", start) + 1, indent = body.slice(lineStart, start);
    const replacement = rememberOld ? !indent.trim() ? `// ${statement}
${indent}${next}` : `/* ${statement.replace(/\*\//g, "* /")} */ ${next}` : next;
    changes.push({ start, end, replacement });
  }
  if (!changes.length) return `${body.trimEnd()}
    ${name} ${value}
`;
  for (const change of changes.reverse()) body = body.slice(0, change.start) + change.replacement + body.slice(change.end);
  return body;
}
function editBlock(text, name, edit) {
  const blocks = gradleBlocks(text).filter((block) => block.name === name).reverse();
  for (const block of blocks) text = text.slice(0, block.open + 1) + edit(text.slice(block.open + 1, block.end - 1)) + text.slice(block.end - 1);
  return text;
}
function moduleMinSdk(text) {
  const mask = gradleMask(text);
  return Math.max(GAME_ANDROID.minSdk, ...[...mask.matchAll(/\bminSdk(?:Version)?\s*(?:=\s*)?(\d+)/g)].map((match) => Number(match[1])));
}
function normalizeGameGradle(text, options) {
  if (!gradleBlocks(text).some((block) => block.name === "android")) return text;
  text = editBlock(text, "android", (body) => {
    body = setValue(body, /\bcompileSdkVersion\b/.test(gradleMask(body)) ? "compileSdkVersion" : "compileSdk", String(GAME_ANDROID.compileSdk));
    body = setValue(body, "buildToolsVersion", groovy(GAME_ANDROID.buildTools));
    if (options.primary || /\bndkPath\b/.test(gradleMask(body))) {
      body = setValue(body, "ndkPath", groovy(options.ndkPath), true);
      body = setValue(body, "ndkVersion", groovy(GAME_ANDROID.ndk));
    }
    return body;
  });
  return editBlock(text, "defaultConfig", (body) => {
    body = setValue(body, /\bminSdkVersion\b/.test(gradleMask(body)) ? "minSdkVersion" : "minSdk", String(Math.max(options.minSdk, moduleMinSdk(body))));
    body = setValue(body, /\btargetSdkVersion\b/.test(gradleMask(body)) ? "targetSdkVersion" : "targetSdk", String(GAME_ANDROID.targetSdk));
    if (options.primary || /\bversionCode\b/.test(gradleMask(body))) body = setValue(body, "versionCode", String(options.versionCode));
    if (options.primary || /\bversionName\b/.test(gradleMask(body))) body = setValue(body, "versionName", groovy(options.versionName));
    return body;
  });
}
function signingReferences(text) {
  const references = [], mask = gradleMask(text);
  for (const block of gradleBlocks(text).filter((item) => item.parent?.name === "signingConfigs")) {
    const body = text.slice(block.open + 1, block.end - 1);
    for (const match of body.matchAll(/\bstoreFile\s*(?:=\s*)?file\s*\(\s*(['"])((?:\\.|[^\\])*?)\1\s*\)/g)) {
      const start = block.open + 1 + match.index;
      if (!mask.slice(start, start + 9).trim()) continue;
      references.push({ start, end: start + match[0].length, original: match[0], path: match[2].replace(/\\(['"\\])/g, "$1"), alias: gradleLiteral(body, "keyAlias"), storePassword: gradleLiteral(body, "storePassword"), keyPassword: gradleLiteral(body, "keyPassword") });
    }
  }
  return references;
}
function signingFileName(path) {
  return basename(path.replace(/\\/g, "/"));
}
function replaceSigningReference(text, reference, moduleDirectory, key) {
  const next = `storeFile file(${groovy(relative(moduleDirectory, key).split("\\").join("/"))})`;
  const absolute = isAbsolute(reference.path) || /^[A-Za-z]:[\\/]/.test(reference.path);
  if (!absolute && resolve(moduleDirectory, reference.path) === key) return text;
  const indent = /^[ \t]*/.exec(text.slice(text.lastIndexOf("\n", reference.start) + 1, reference.start))?.[0] || "";
  return text.slice(0, reference.start) + (absolute ? `// ${reference.original}
${indent}` : "") + next + text.slice(reference.end);
}
function normalizeGameSettings(text, repository) {
  const mask = gradleMask(text);
  text = text.replace(/\burl\s*(?:=\s*)?(['"])([^'"\r\n]*)\1/g, (whole, _quote, url, offset) => {
    if (!mask.slice(offset, offset + 3).trim() || !/^file:/i.test(url) || !/firebase[\\/]m2repository\/?$/i.test(url)) return whole;
    return `url ${groovy(pathToFileURL(repository).href)}`;
  });
  const blocks = gradleBlocks(text);
  const repositoryBlocks = blocks.filter((block) => block.name === "repositories" && block.parent?.name === "dependencyResolutionManagement");
  for (const repos of repositoryBlocks.reverse()) {
    const pangle = blocks.find((block) => block.name === "maven" && block.parent === repos && /https:\/\/artifact\.bytedance\.com\/repository\/pangle/.test(text.slice(block.open, block.end)));
    if (!pangle || !gradleMask(text.slice(repos.open + 1, pangle.start)).trim()) continue;
    const lineStart = text.lastIndexOf("\n", pangle.start) + 1;
    const start = text.slice(lineStart, pangle.start).trim() ? pangle.start : lineStart;
    const snippet = text.slice(start, pangle.end).trim();
    const without = text.slice(0, start) + text.slice(pangle.end);
    text = without.slice(0, repos.open + 1) + `
        ${snippet}
` + without.slice(repos.open + 1);
  }
  return text;
}
function setJavaProperty(text, name, value, rememberOld = false) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(`^[ \\t]*${escaped}[ \\t]*=[^\\r\\n]*`, "gm");
  let found = false;
  const output = text.replace(expression, (old) => {
    if (found) return `# ${old}`;
    found = true;
    const next = `${name}=${value.replace(/\\/g, "\\\\")}`;
    return old.trim() === next ? old : `${rememberOld ? `# ${old}
` : ""}${next}`;
  });
  return found ? output : `${text.trimEnd()}
${name}=${value}
`;
}
function javaProperty(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^[ \\t]*${escaped}[ \\t]*=[ \\t]*(.*)$`, "m").exec(text)?.[1]?.trim().replace(/\\([\\: =])/g, "$1");
}
export {
  GAME_ANDROID,
  gradleBlocks,
  gradleLiteral,
  gradleMask,
  javaProperty,
  moduleMinSdk,
  normalizeGameGradle,
  normalizeGameSettings,
  replaceSigningReference,
  setJavaProperty,
  signingFileName,
  signingReferences
};
