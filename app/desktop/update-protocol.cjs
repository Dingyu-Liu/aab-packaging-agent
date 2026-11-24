const { isIP } = require('node:net');
const { createPublicKey, verify, sign } = require('node:crypto');
const { macArchitecture } = require('./macos-arch.cjs');
const PRODUCT_ID = 'com.partneragent.desktop';
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const FILE = /^Partner-Agent-\d+\.\d+\.\d+-mac-(x64|arm64)\.(zip|dmg)$/;
function compareVersions(a, b) {
  if (!VERSION.test(a) || !VERSION.test(b) || [...a.split('.'), ...b.split('.')].some(value => !Number.isSafeInteger(Number(value)))) throw new Error('应用版本号无效。');
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}
function serverUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('请输入完整的更新服务器地址。');
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('更新地址格式无效。'); }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const privateHost = host === 'localhost' || host === '::1' || host.endsWith('.local') || (isIP(host) === 4 && (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host))) || (isIP(host) === 6 && /^(fc|fd)[\da-f]{2}:/.test(host));
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && privateHost)) throw new Error('公网更新服务须使用 HTTPS；本机和局域网可使用 HTTP。');
  if (url.username || url.password || url.search || url.hash) throw new Error('更新地址不能包含账号、查询参数或片段。');
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}
function validateRelease(data, expectedArch) {
  if (!data || data.schemaVersion !== 1 || data.productId !== PRODUCT_ID || data.platform !== 'darwin' || !['x64', 'arm64'].includes(data.arch) || !VERSION.test(data.version)) throw new Error('更新清单不属于本应用或受支持的 Mac 平台。');
  if (expectedArch !== undefined && data.arch !== macArchitecture(expectedArch).arch) throw new Error(`更新包架构与当前 ${macArchitecture(expectedArch).label} 不匹配。`);
  if (!Number.isFinite(Date.parse(data.publishedAt)) || typeof data.notes !== 'string' || data.notes.length > 16000) throw new Error('更新清单格式无效。');
  const file = data.archive;
  if (!file || file.file !== `Partner-Agent-${data.version}-mac-${data.arch}.zip` || !FILE.test(file.file) || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > 2_147_483_648 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('更新包的文件、大小或校验信息无效。');
  if (data.installer && (data.installer.file !== `Partner-Agent-${data.version}-mac-${data.arch}.dmg` || !Number.isSafeInteger(data.installer.size) || data.installer.size <= 0 || !/^[a-f0-9]{64}$/.test(data.installer.sha256))) throw new Error('安装包信息无效。');
  if (data.nextServerUrl !== undefined) serverUrl(data.nextServerUrl);
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(data.minimumMacOS || '')) throw new Error('更新包缺少最低系统版本。');
  return data;
}
function decodeEnvelope(envelope, publicKey, expectedArch) {
  if (!envelope || typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string' || envelope.payload.length > 100_000 || envelope.signature.length !== 88) throw new Error('更新清单签名格式无效。');
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('更新公钥类型无效。');
  const bytes = Buffer.from(envelope.payload, 'base64');
  if (!verify(null, bytes, key, Buffer.from(envelope.signature, 'base64'))) throw new Error('更新清单签名不正确，已拒绝此更新。');
  return validateRelease(JSON.parse(bytes.toString('utf8')), expectedArch);
}
function createEnvelope(release, privateKey) {
  const payload = Buffer.from(JSON.stringify(validateRelease(release)));
  return { payload: payload.toString('base64'), signature: sign(null, payload, privateKey).toString('base64') };
}
module.exports = { PRODUCT_ID, compareVersions, serverUrl, validateRelease, decodeEnvelope, createEnvelope };
