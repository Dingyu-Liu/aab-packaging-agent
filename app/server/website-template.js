import { AppError } from "./errors.js";
function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError(502, "模型返回的页面内容格式无效，请重新生成。");
  return value;
}
function text(value, limit = 5e3) {
  if (typeof value !== "string" || !value.trim() || value.length > limit || value.includes("\0")) throw new AppError(502, "模型返回的页面文字不完整或过长，请重新生成。");
  return value.trim();
}
function parseWebsiteContent(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
  } catch {
    throw new AppError(502, "模型未返回完整的页面 JSON，请重新生成。");
  }
  const item = record(parsed), privacy = record(item.privacy);
  if (!Array.isArray(item.features) || !item.features.length || item.features.length > 8 || !Array.isArray(privacy.sections) || privacy.sections.length < 3 || privacy.sections.length > 20 || !Array.isArray(item.missingFacts) || item.missingFacts.length > 20) throw new AppError(502, "模型返回的官网或隐私页内容不完整，请重新生成。");
  const language = text(item.language, 35);
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(language)) throw new AppError(502, "模型返回的页面语言无效，请重新生成。");
  return {
    name: text(item.name, 120),
    language,
    tagline: text(item.tagline, 300),
    introduction: text(item.introduction, 3e3),
    features: item.features.map((value) => {
      const feature = record(value);
      return { title: text(feature.title, 150), description: text(feature.description, 1500) };
    }),
    privacy: { title: text(privacy.title, 200), introduction: text(privacy.introduction, 4e3), sections: privacy.sections.map((value) => {
      const section = record(value);
      return { title: text(section.title, 200), body: text(section.body, 8e3) };
    }) },
    missingFacts: item.missingFacts.map((value) => text(value, 500))
  };
}
function escapeWebsiteText(value) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}
const WEBSITE_STYLES = `
:root{color-scheme:light;--ink:#192e2a;--muted:#64766f;--green:#11644c;--border:#dce6df;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;color:var(--ink);background:#f8faf6;line-height:1.75}a{color:inherit;text-underline-offset:4px}a:focus-visible{outline:3px solid #c3a551;outline-offset:5px}header{border-bottom:1px solid var(--border);background:#fff}nav{max-width:1120px;margin:auto;min-height:82px;padding:18px 32px;display:flex;align-items:center;justify-content:space-between;gap:24px}.brand{font-weight:750;font-size:21px;text-decoration:none;letter-spacing:-.5px;overflow-wrap:anywhere}.brand-mark{display:inline-grid;place-items:center;background:var(--green);color:#fff;border-radius:11px;width:35px;height:35px;margin-right:10px;font-size:17px}nav div{display:flex;gap:24px;flex-shrink:0}nav div a{text-decoration:none;font-size:14px;color:var(--muted)}nav a[aria-current=page]{color:var(--green);font-weight:650}.hero{max-width:1120px;margin:0 auto;padding:105px 32px 86px;display:grid;grid-template-columns:1.3fr .7fr;gap:60px;align-items:center}.eyebrow{text-transform:uppercase;font-size:12px;font-weight:700;letter-spacing:2px;color:var(--green);margin:0 0 20px}.hero h1{font-size:clamp(36px,5.5vw,64px);line-height:1.15;letter-spacing:-2px;overflow-wrap:anywhere;margin:0 0 24px}.lead{font-size:17px;color:var(--muted);max-width:640px;white-space:pre-line}.actions{display:flex;flex-wrap:wrap;gap:14px;margin-top:32px}.button{display:inline-block;padding:12px 22px;border-radius:7px;background:var(--green);color:#fff;text-decoration:none;font-size:14px;font-weight:650}.button.secondary{background:transparent;border:1px solid #bccdc2;color:var(--green)}.hero-art{aspect-ratio:1;background:#e5eee0;border-radius:44% 44% 18% 44%;display:grid;place-items:center;position:relative;overflow:hidden}.hero-art:before{content:"";position:absolute;inset:17%;border:1px solid #73937c;border-radius:50%}.hero-art:after{content:"";position:absolute;width:35%;height:35%;border-radius:50%;background:#becfb0;top:7%;right:-10%}.monogram{font-family:Georgia,serif;font-size:120px;font-weight:400;color:#28543c;z-index:1}.feature-area{background:#fff;border-block:1px solid var(--border)}.features{max-width:1120px;margin:auto;padding:62px 32px;display:grid;grid-template-columns:repeat(3,1fr);gap:36px}.feature-number{color:#7f9787;font-size:12px;letter-spacing:1px}.features h2{font-size:19px;margin:12px 0}.features p{font-size:14px;color:var(--muted);white-space:pre-line;margin:0}.trust{max-width:1120px;margin:0 auto;padding:60px 32px;display:flex;justify-content:space-between;align-items:center;gap:30px}.trust h2{font-size:24px;margin:0 0 10px}.trust p{margin:0;color:var(--muted);font-size:14px}.policy-layout{max-width:1120px;margin:auto;padding:64px 32px 90px;display:grid;grid-template-columns:210px 1fr;gap:64px}.policy-nav{align-self:start;position:sticky;top:28px;border-left:2px solid var(--border);padding-left:18px}.policy-nav a{display:block;font-size:13px;text-decoration:none;color:var(--muted);margin:12px 0}.policy h1{font-size:38px;line-height:1.2;letter-spacing:-1px;margin:0 0 18px}.policy h2{font-size:21px;margin:0 0 15px}.policy section{scroll-margin-top:28px;margin-top:36px;padding-top:28px;border-top:1px solid var(--border)}.policy p{color:var(--muted);white-space:pre-line;font-size:15px}.policy-date{font-size:12px;color:var(--muted)}.notice{border:1px solid #e5d4a9;background:#fffaf0;color:#7b5c22;border-radius:8px;padding:16px 20px;margin-top:28px;font-size:13px}.notice p{color:inherit}.notice ul{margin:8px 0;padding-left:20px}.source-link{font-size:13px;color:var(--green);display:inline-block;margin-top:18px}footer{max-width:1120px;margin:auto;padding:28px 32px;border-top:1px solid var(--border);display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px;color:var(--muted);font-size:12px}footer div{display:flex;gap:22px}@media(max-width:760px){nav{padding:16px 22px;gap:12px;flex-wrap:wrap}nav div{gap:18px}.brand{font-size:18px}.hero{padding:65px 24px;grid-template-columns:1fr;gap:34px}.hero-art{max-width:240px;justify-self:center;width:100%}.monogram{font-size:85px}.features{padding:40px 24px;grid-template-columns:1fr;gap:30px}.trust{padding:40px 24px;align-items:flex-start;flex-direction:column}.policy-layout{padding:40px 24px;grid-template-columns:1fr;gap:28px}.policy-nav{position:static;display:flex;flex-wrap:wrap;gap:0 16px}.policy h1{font-size:30px}footer{padding:24px}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}`;
function renderWebsiteProject(content, input, date, warnings) {
  const e = escapeWebsiteText, zh = content.language.toLowerCase().startsWith("zh");
  const home = zh ? "官网" : "Home", policy = zh ? "隐私政策" : "Privacy Policy";
  const notice = content.missingFacts.length ? `<aside class="notice"><strong>${zh ? "发布前待补充或确认" : "Details to confirm before publishing"}</strong><ul>${content.missingFacts.map((item) => `<li>${e(item)}</li>`).join("")}</ul></aside>` : "";
  const paragraphs = (body) => body.split(/\n\s*\n/).map((line) => `<p>${e(line)}</p>`).join("");
  const source = (url) => url ? `<a class="source-link" href="${e(url)}" target="_blank" rel="noopener noreferrer">${zh ? "查看提供的参考页面" : "View supplied reference"}</a>` : "";
  const document = (kind, body) => `<!doctype html>
<html lang="${e(content.language)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="${e(kind === "website" ? content.introduction.slice(0, 200) : content.privacy.introduction.slice(0, 200))}"><title>${e(kind === "website" ? content.name : `${content.privacy.title} · ${content.name}`)}</title><link rel="stylesheet" href="styles.css"></head>
<body><header><nav aria-label="${zh ? "主导航" : "Main navigation"}"><a class="brand" href="index.html"><span class="brand-mark" aria-hidden="true">${e(Array.from(content.name)[0])}</span>${e(content.name)}</a><div><a href="index.html"${kind === "website" ? ' aria-current="page"' : ""}>${home}</a><a href="privacy.html"${kind === "privacy" ? ' aria-current="page"' : ""}>${policy}</a></div></nav></header>${body}<footer><span>© ${date.slice(0, 4)} ${e(content.name)}</span><div><a href="index.html">${home}</a><a href="privacy.html">${policy}</a></div></footer></body></html>`;
  const index = document("website", `<main><section class="hero"><div><p class="eyebrow">${e(content.name)}</p><h1>${e(content.tagline)}</h1><p class="lead">${e(content.introduction)}</p><div class="actions"><a class="button" href="#features">${zh ? "了解更多" : "Explore features"}</a><a class="button secondary" href="privacy.html">${policy}</a></div>${source(input.websiteUrl)}</div><div class="hero-art" aria-hidden="true"><span class="monogram">${e(Array.from(content.name)[0])}</span></div></section><section class="feature-area" id="features"><div class="features">${content.features.map((item, index2) => `<article><span class="feature-number">0${index2 + 1}</span><h2>${e(item.title)}</h2>${paragraphs(item.description)}</article>`).join("")}</div></section><section class="trust"><div><h2>${policy}</h2><p>${e(content.privacy.introduction.slice(0, 180))}</p></div><a class="button secondary" href="privacy.html">${zh ? "查看隐私政策" : "Read privacy policy"} →</a></section></main>`);
  const privacy = document("privacy", `<main class="policy-layout"><aside class="policy-nav" aria-label="${zh ? "隐私政策目录" : "Policy contents"}">${content.privacy.sections.map((item, index2) => `<a href="#section-${index2 + 1}">${e(item.title)}</a>`).join("")}</aside><article class="policy"><p class="eyebrow">${e(content.name)}</p><h1>${e(content.privacy.title)}</h1><div class="policy-date">${zh ? "页面生成日期" : "Page generated"} · ${e(date)}</div>${paragraphs(content.privacy.introduction)}${notice}${content.privacy.sections.map((item, index2) => `<section id="section-${index2 + 1}"><h2>${e(item.title)}</h2>${paragraphs(item.body)}</section>`).join("")}${source(input.privacyUrl)}<div class="actions"><a class="button secondary" href="index.html">← ${zh ? "返回官网" : "Back to home"}</a></div></article></main>`);
  if (!index.includes('href="privacy.html"') || !privacy.includes('href="index.html"')) throw new AppError(500, "官网与隐私页的跳转校验失败。");
  return {
    "index.html": index,
    "privacy.html": privacy,
    "styles.css": WEBSITE_STYLES,
    "README.md": `# ${content.name}

官网：index.html
隐私页：privacy.html

两个页面共用 styles.css，使用相对链接互相跳转。请将整个目录部署到同一静态网站路径，保留文件名。无构建步骤、无需安装依赖。

所选生成目标：${input.targets.join("、")}。未选择的页面自动作为配套页附带。

工作台预览地址仅能在本机访问；部署后，官网地址为站点根路径 /index.html，隐私链接为 /privacy.html。发布时填写自己的域名。

${warnings.length ? `## 待确认信息

${warnings.map((item) => `- ${item}`).join("\n")}
` : ""}`
  };
}
export {
  WEBSITE_STYLES,
  escapeWebsiteText,
  parseWebsiteContent,
  renderWebsiteProject
};
