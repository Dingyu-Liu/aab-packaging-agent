import { createApplicationByRole } from "./app.js";
import { resolveRole } from "./role.js";
const role = resolveRole();
const portIndex = process.argv.indexOf("--port");
const portArgument = portIndex >= 0 ? process.argv[portIndex + 1] : void 0;
if (portIndex >= 0 && !portArgument) throw new Error("--port 需要端口号。");
const port = Number(process.env.PARTNER_AGENT_PORT || portArgument || 4317);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PARTNER_AGENT_PORT 无效。");
const host = process.env.PARTNER_AGENT_HOST || "127.0.0.1";
if (role === "local" && !["127.0.0.1", "localhost", "::1"].includes(host)) {
  throw new Error("local 角色只允许监听本机回环地址；云端请使用 registry 角色。");
}
const application = await createApplicationByRole({ dev: process.argv.includes("--dev") });
try {
  await new Promise((done, fail) => {
    application.server.once("error", fail);
    application.server.listen(port, host, () => {
      application.server.off("error", fail);
      done();
    });
  });
} catch (error) {
  await application.close();
  throw error;
}
const address = application.server.address();
const actualPort = typeof address === "object" && address ? address.port : port;
const urlHost = host.includes(":") ? `[${host}]` : host;
console.log(`Partner Agent ready (${role}): http://${urlHost}:${actualPort}`);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await application.close();
  process.exit(0);
}
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
