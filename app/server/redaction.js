class Redactor {
  values = /* @__PURE__ */ new Set();
  add(value) {
    if (typeof value === "string" && value.length > 0) this.values.add(value);
  }
  text(value) {
    let out = value;
    for (const secret of [...this.values].sort((a, b) => b.length - a.length)) {
      if (secret.length >= 4) out = out.split(secret).join("[已隐藏]");
      else {
        const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        out = out.replace(new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "g"), "[已隐藏]");
      }
    }
    return out.replace(/\b(Bearer\s+)[\w.\-+/=]{8,}/gi, "$1[已隐藏]").replace(/((?:api[_-]?key|password|access[_-]?token|devkey|authorization)\s*[=:]\s*["']?)[^\s"',}]{6,}/gi, "$1[已隐藏]");
  }
  json(value) {
    const visit = (item) => {
      if (typeof item === "string") return this.text(item);
      if (Array.isArray(item)) return item.map(visit);
      if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, visit(entry)]));
      return item;
    };
    return visit(value);
  }
}
export {
  Redactor
};
