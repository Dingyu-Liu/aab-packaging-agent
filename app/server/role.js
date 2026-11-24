function resolveRole(value = process.env.PARTNER_AGENT_ROLE) {
  if (value === "local" || value === "registry") return value;
  throw new Error("必须显式设置 PARTNER_AGENT_ROLE=local 或 PARTNER_AGENT_ROLE=registry。");
}
function assertLocalApplicationRole() {
  if (process.env.PARTNER_AGENT_ROLE === void 0) return;
  if (resolveRole() !== "local") {
    throw new Error("registry 角色不能创建本地执行端。");
  }
}
export {
  assertLocalApplicationRole,
  resolveRole
};
