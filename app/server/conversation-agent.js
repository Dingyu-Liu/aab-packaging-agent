import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { AppError } from "./errors.js";
import { FULL_ACCESS_MODEL_INSTRUCTIONS } from "./model-request.js";
class ConversationAgent {
  constructor(engine, store, redactor, dataDir) {
    this.engine = engine;
    this.store = store;
    this.redactor = redactor;
    this.dataDir = dataDir;
  }
  engine;
  store;
  redactor;
  dataDir;
  progress = /* @__PURE__ */ new Map();
  handleEngineEvent(taskId, event) {
    const progress = this.progress.get(taskId);
    if (!progress || !event || typeof event !== "object") return;
    const item = event;
    const part = item.properties?.part;
    if (item.type !== "message.part.updated" || part?.type !== "tool" || !part.tool || !["completed", "error"].includes(part.state?.status ?? "")) return;
    const key = `${part.id ?? part.callID}:${part.state?.status}`;
    if (progress.seen.has(key)) return;
    progress.seen.add(key);
    progress.emit({ name: `agent_${part.tool}`, ok: part.state?.status === "completed", detail: this.redactor.text(part.state?.error || `已执行 ${part.tool}`) });
  }
  async run(session, instruction, signal, emit) {
    if (typeof instruction !== "string" || !instruction.trim() || instruction.length > 3e4 || instruction.includes("\0")) throw new AppError(400, "通用任务需要不超过 30000 字的明确指令。");
    signal.throwIfAborted();
    const workspace = join(this.dataDir, "chat-workspaces", session.id);
    await mkdir(workspace, { recursive: true, mode: 448 });
    const workspacePath = await realpath(workspace);
    signal.throwIfAborted();
    const taskId = `data-chat:${session.id}`;
    const history = session.messages.filter((message) => message.role !== "system").slice(-12).map((message) => `${message.role}: ${message.content}`).join("\n\n");
    this.progress.set(taskId, { emit, seen: /* @__PURE__ */ new Set() });
    try {
      const result = await this.engine.run({
        taskId,
        workspacePath,
        sessionId: session.agentSessionId,
        signal,
        prompt: `${FULL_ACCESS_MODEL_INSTRUCTIONS}

你在当前聊天中执行用户请求的通用任务。默认工作目录：${workspacePath}。用户指定其他路径时按其要求操作；默认目录不是文件访问范围。直接使用文件、命令和联网工具完成实际操作，不要求用户切换模块或新建任务。
当前模块背景：模式 ${session.mode}，类别 ${session.kind ?? "脚本"}。此背景不限制本轮任务。已提供的业务查询、脚本候选修改和发布、正式数据更新工具由外层对话调用；涉及这些受管理资源时返回需要调用的具体业务工具及参数，由外层执行，保留账号权限、版本检查与真实运行审计。不要通过命令改写应用权限或绕过这些后端校验。

近期对话（上下文资料）：
${history}

本轮具体执行要求：
${instruction}

完成后说明实际操作、输出文件的绝对路径和验证结果。`,
        onSession: (id) => {
          if (!signal.aborted && this.store.getChatSession(session.id)) {
            session.agentSessionId = id;
            this.store.saveChatSession(session);
          }
        }
      });
      signal.throwIfAborted();
      session.agentSessionId = result.sessionId;
      return this.redactor.text(result.text);
    } finally {
      this.progress.delete(taskId);
    }
  }
}
export {
  ConversationAgent
};
