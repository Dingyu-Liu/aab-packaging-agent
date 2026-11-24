import { cp, mkdir, readdir, readFile, lstat, writeFile, realpath } from "node:fs/promises";
import { join, dirname, relative, basename, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { skillPath } from "./plugins.js";
import { AppError } from "./errors.js";
import { pathExists, readPrivateJson, readRegularFile, writePrivateFile } from "./package-validation.js";
async function freezeModule(directory, plugin, profile, taskDir, model, options) {
  const frozen = join(taskDir, "module");
  await mkdir(frozen, { recursive: true, mode: 448 });
  const hashes = {};
  const hash = (content) => createHash("sha256").update(content).digest("hex");
  const hashTree = async (path) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name), rel = relative(frozen, file).split("\\").join("/");
      if (entry.isDirectory()) await hashTree(file);
      else if (entry.isFile() && rel !== "manifest.json") hashes[rel] = hash(await readFile(file));
    }
  };
  const filter = async (path) => !(await lstat(path)).isSymbolicLink() && !relative(directory, path).split(/[\\/]/).some((part) => [".git", "__pycache__", "node_modules"].includes(part));
  if (profile) {
    const skill = await skillPath(directory, profile), target = join(frozen, profile.skill.path);
    await mkdir(dirname(target), { recursive: true });
    await cp(dirname(skill), dirname(target), { recursive: true, filter });
  } else if (plugin.script) {
    await cp(directory, frozen, { recursive: true, filter });
  }
  let origin = options ? { source: options.source, packSha256: options.packSha256, releaseId: options.releaseId } : { source: "local" };
  if (!options && await pathExists(join(directory, ".package-origin.json"))) origin = await readPrivateJson(join(directory, ".package-origin.json"), 16384);
  let parameters = options && "parameters" in options && options.parameters ? { ...options.parameters } : void 0;
  if (plugin.script?.runner === "external" && parameters?.scriptPath) {
    if (typeof parameters.scriptPath !== "string" || !isAbsolute(parameters.scriptPath)) throw new AppError(400, "外部脚本冻结需要绝对路径。");
    let selected;
    try {
      selected = await realpath(parameters.scriptPath);
    } catch {
      throw new AppError(400, "外部脚本不存在，不能创建冻结任务。");
    }
    const content = await readRegularFile(selected, 8 * 1024 * 1024);
    const target = join(frozen, "external", basename(selected));
    await mkdir(dirname(target), { recursive: true, mode: 448 });
    await writePrivateFile(target, content);
    const workingDirectory = typeof parameters.workingDirectory === "string" && parameters.workingDirectory.trim() ? parameters.workingDirectory : dirname(selected);
    parameters = { ...parameters, scriptPath: target, workingDirectory };
  }
  await hashTree(frozen);
  const lock = JSON.stringify({
    schemaVersion: 1,
    module: { id: plugin.id, version: plugin.version, manifestSha256: hash(JSON.stringify(plugin)), source: origin.source, ...origin.packSha256 ? { packSha256: origin.packSha256 } : {}, ...origin.releaseId ? { releaseId: origin.releaseId } : {} },
    profile: profile ? { id: profile.id, version: profile.version, skillVersion: profile.skill.version } : null,
    engine: { name: "OpenCode", version: "1.19.5" },
    model: model || null,
    resources: hashes,
    createdAt: (/* @__PURE__ */ new Date()).toISOString()
  }, null, 2);
  await writeFile(join(frozen, "manifest.json"), JSON.stringify(plugin, null, 2), { mode: 384 });
  return { directory: frozen, lock, ...parameters ? { parameters } : {} };
}
export {
  freezeModule
};
