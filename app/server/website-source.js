import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { AppError } from "./errors.js";
const excluded = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
]) excluded.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [["2001:db8::", 32], ["2001::", 32], ["2002::", 16]]) excluded.addSubnet(address, prefix, "ipv6");
const publicV6 = new BlockList();
publicV6.addSubnet("2000::", 3, "ipv6");
function publicWebsiteAddress(address) {
  const family = isIP(address);
  return family === 4 ? !excluded.check(address, "ipv4") : family === 6 && publicV6.check(address, "ipv6") && !excluded.check(address, "ipv6");
}
function entities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, entity) => {
    const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
    if (entity[0] !== "#") return named[entity.toLowerCase()] ?? whole;
    const number = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return number > 0 && number <= 1114111 && !(number >= 55296 && number <= 57343) ? String.fromCodePoint(number) : " ";
  });
}
function websiteText(html, url) {
  const strip = (text2) => entities(text2.replace(/<[^>]*>/g, " ")).replace(/[\t ]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
  const title = strip(html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] ?? "").slice(0, 250);
  const content = html.replace(/<(script|style|noscript|svg|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ").replace(/<\/(?:p|div|h[1-6]|li|section|article)>/gi, "\n");
  const text = strip(content).slice(0, 24e3);
  if (text.length < 30) throw new AppError(400, "网页没有可读取的正文，可能需要登录或依赖脚本渲染，请补充关键词或描述。");
  return { url, title, text };
}
async function readWebsiteSource(sourceUrl, signal) {
  const combined = AbortSignal.any([signal, AbortSignal.timeout(2e4)]);
  let url = new URL(sourceUrl);
  for (let hop = 0; hop <= 4; hop++) {
    combined.throwIfAborted();
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port && !["80", "443"].includes(url.port)) throw new AppError(400, "参考链接须为使用标准端口的公开 HTTP/HTTPS 网页。");
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await Promise.race([
      lookup(hostname, { all: true }),
      new Promise((_, reject) => {
        if (combined.aborted) reject(combined.reason);
        else combined.addEventListener("abort", () => reject(combined.reason), { once: true });
      })
    ]);
    if (!addresses.length || addresses.some((item) => !publicWebsiteAddress(item.address))) throw new AppError(400, "参考链接须可从公网读取，不支持本机、内网或保留地址。");
    const pinned = addresses[0];
    const result = await new Promise((done, fail) => {
      const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
      const req = transport(url, {
        signal: combined,
        agent: false,
        maxHeaderSize: 16384,
        headers: { Accept: "text/html, text/plain;q=0.8", "Accept-Encoding": "identity", "User-Agent": "Partner-Agent-Website/0.1" },
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
          else callback(null, pinned.address, pinned.family);
        }
      }, (response) => {
        const status = response.statusCode ?? 500;
        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = response.headers.location;
          response.destroy();
          if (!location) fail(new AppError(400, "参考网页的跳转地址为空。"));
          else done({ location });
          return;
        }
        if (status < 200 || status >= 300) {
          response.destroy();
          fail(new AppError(400, `参考网页返回 HTTP ${status}，请补充描述或使用可访问的链接。`));
          return;
        }
        if (!/^(?:text\/(?:html|plain)|application\/xhtml\+xml)(?:;|$)/i.test(response.headers["content-type"] ?? "")) {
          response.destroy();
          fail(new AppError(400, "参考链接须指向 HTML 或文本网页。"));
          return;
        }
        const chunks = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > 1e6) {
            response.destroy();
            fail(new AppError(400, "参考网页内容过大，请改用正文页面或填写描述。"));
          } else chunks.push(chunk);
        });
        response.once("error", fail);
        response.once("end", () => {
          const charset = /charset=["']?([^;\s"']+)/i.exec(response.headers["content-type"] ?? "")?.[1] ?? "utf-8";
          let decoder;
          try {
            decoder = new TextDecoder(charset);
          } catch {
            decoder = new TextDecoder();
          }
          done({ html: decoder.decode(Buffer.concat(chunks)) });
        });
      });
      req.once("error", fail);
      req.end();
    });
    if (result.location) {
      url = new URL(result.location, url);
      continue;
    }
    return websiteText(result.html, url.href);
  }
  throw new AppError(400, "参考网页跳转次数过多，请使用最终页面地址。");
}
export {
  publicWebsiteAddress,
  readWebsiteSource,
  websiteText
};
