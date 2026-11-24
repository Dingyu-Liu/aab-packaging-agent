import { AppError } from "./errors.js";
async function feishuCallback(feishu, url, res) {
  let ok = false, message = "";
  try {
    await feishu.callback(url.searchParams);
    ok = true;
    message = "已连接飞书，可以关闭此窗口并返回工作台。";
  } catch (error) {
    message = error instanceof AppError ? error.message : "飞书连接失败，请回到工作台重试。";
  }
  const escape = (value) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  res.writeHead(ok ? 200 : 400, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
  });
  res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${ok ? "已连接飞书" : "飞书授权未完成"} · Partner Agent</title><style>*{box-sizing:border-box}body{margin:0;background:#f6f8f7;color:#263e36;font:15px/1.8 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:grid;min-height:100vh;place-items:center;padding:24px}main{max-width:460px;width:100%;background:white;border:1px solid #e2ebe6;border-radius:20px;padding:44px;text-align:center}.mark{margin:auto auto 22px;width:54px;height:54px;display:grid;place-items:center;border-radius:50%;background:#edf5f0;color:#168571;font-size:25px}h1{font-size:23px;margin:0 0 12px}p{color:#74847c;margin:0 0 28px}a{display:inline-block;text-decoration:none;background:#158371;color:white;padding:10px 22px;border-radius:8px}</style><main><div class="mark">${ok ? "✓" : "!"}</div><h1>${ok ? "飞书连接成功" : "授权尚未完成"}</h1><p>${escape(message)}</p><a href="/#overview">返回工作台</a></main></html>`);
}
export {
  feishuCallback
};
