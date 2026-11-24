import { AppError } from "./errors.js";
const gpDecisionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: ["retry", "compile", "resume", "package", "reply", "pause", "ask_user"] },
    message: { type: "string", description: "面向用户的中文回复，说明实际检查、改动和接下来会执行的操作。" },
    blocker: {
      type: "object",
      additionalProperties: false,
      properties: {
        reason: { type: "string", enum: ["external_parameter", "credentials", "decision", "permission", "environment", "runner", "model", "interrupted"] },
        question: { type: "string", description: "确实需要用户回答或处理的具体问题；可自行解决的错误不能据此暂停。" },
        details: { type: "string", description: "实际检查证据，以及为什么无法自行处理；不能只以尝试轮数或相同报错作为依据。" }
      },
      required: ["reason", "question", "details"]
    },
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        versionName: { type: "string" },
        versionCode: { type: "integer", minimum: 1, maximum: 21e8 },
        module: { type: "string" },
        variant: { type: "string" }
      }
    },
    timeoutMinutes: { type: "integer", minimum: 1, maximum: 1440, description: "本次任务的 Gradle 等待时限；不修改全局设置。" }
  },
  required: ["action", "message"]
};
class GpInputRequired extends AppError {
  constructor(blocker) {
    super(409, blocker.question);
    this.blocker = blocker;
  }
  blocker;
}
function gpAgentDecision(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidDecision();
  const item = value;
  if (!["retry", "compile", "resume", "package", "reply", "pause", "ask_user"].includes(String(item.action)) || typeof item.message !== "string" || !item.message.trim()) throw invalidDecision();
  const decision = { action: item.action, message: item.message.slice(0, 3e4) };
  if (item.action === "ask_user") {
    const blocker = item.blocker;
    const reasons = ["external_parameter", "credentials", "decision", "permission", "environment", "runner", "model", "interrupted"];
    if (!blocker || !reasons.includes(blocker.reason) || typeof blocker.question !== "string" || !blocker.question.trim() || typeof blocker.details !== "string" || !blocker.details.trim()) throw invalidDecision();
    decision.blocker = { reason: blocker.reason, question: blocker.question.slice(0, 6e3), ...typeof blocker.details === "string" ? { details: blocker.details.slice(0, 12e3) } : {} };
  }
  if (item.parameters !== void 0) {
    if (!item.parameters || typeof item.parameters !== "object" || Array.isArray(item.parameters)) throw invalidDecision();
    const parameters = item.parameters;
    if (Object.keys(parameters).some((key) => !["versionName", "versionCode", "module", "variant"].includes(key))) throw invalidDecision();
    decision.parameters = parameters;
  }
  if (item.timeoutMinutes !== void 0) {
    if (!Number.isInteger(item.timeoutMinutes) || Number(item.timeoutMinutes) < 1 || Number(item.timeoutMinutes) > 1440) throw invalidDecision();
    decision.timeoutMinutes = Number(item.timeoutMinutes);
  }
  return decision;
}
function invalidDecision() {
  return new GpInputRequired({ reason: "model", question: "模型没有返回有效的执行结果。请确认当前模型支持工具调用后回复「继续」，或在设置中更换模型。" });
}
export {
  GpInputRequired,
  gpAgentDecision,
  gpDecisionSchema
};
