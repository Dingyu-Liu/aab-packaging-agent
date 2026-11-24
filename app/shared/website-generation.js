const websitePageLabels = { website: "官网", privacy: "隐私页" };
function validateWebsiteGenerationInput(value) {
  const errors = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return { errors: { form: "生成参数须为对象。" } };
  const raw = value;
  const input = { targets: [] };
  for (const key of ["websiteUrl", "privacyUrl", "description"]) {
    const limit = key === "description" ? 12e3 : 2e3;
    if (raw[key] !== void 0 && typeof raw[key] !== "string") {
      errors[key] = "请输入文字。";
      continue;
    }
    const text = raw[key]?.trim() ?? "";
    if (!text) continue;
    if (text.length > limit || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) {
      errors[key] = `请填写不超过 ${limit} 字的有效内容。`;
      continue;
    }
    if (key !== "description") {
      try {
        const url = new URL(text);
        if (!["https:", "http:"].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error();
        input[key] = url.href;
      } catch {
        errors[key] = "请填写完整的 http:// 或 https:// 网页链接，不含账号密码。";
      }
    } else input.description = text;
  }
  if (!["websiteUrl", "privacyUrl", "description"].some((key) => typeof raw[key] === "string" && raw[key].trim())) errors.sources = "官网、隐私链接、关键词或描述，至少填写一项。";
  if (!Array.isArray(raw.targets) || !raw.targets.length || raw.targets.some((kind) => kind !== "website" && kind !== "privacy")) errors.targets = "请至少选择一个生成目标：官网或隐私页。";
  else input.targets = [...new Set(raw.targets)];
  return Object.keys(errors).length ? { errors } : { input, errors };
}
export {
  validateWebsiteGenerationInput,
  websitePageLabels
};
