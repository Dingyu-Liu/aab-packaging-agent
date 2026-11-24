import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertLocalApplicationRole, resolveRole } from "./role.js";
const VERSION = "0.1.21";
const APP_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
async function createApplication(options = {}) {
  assertLocalApplicationRole();
  const { createLocalApplication } = await import("./app-local.js");
  return createLocalApplication(options);
}
async function createApplicationByRole(options = {}) {
  const role = resolveRole();
  if (role === "registry") {
    throw new Error("公开版仅支持本机桌面模式。");
  }
  return createApplication(options);
}
export {
  APP_ROOT,
  VERSION,
  createApplication,
  createApplicationByRole
};
