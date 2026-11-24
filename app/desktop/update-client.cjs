const fs = require('node:fs/promises');
const { createReadStream, constants } = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { compareVersions, serverUrl, decodeEnvelope, PRODUCT_ID } = require('./update-protocol.cjs');
const { macArchitecture, releaseFeed } = require('./macos-arch.cjs');
const exec = promisify(execFile);
async function hashFile(file) { const hash = createHash('sha256'); for await (const data of createReadStream(file)) hash.update(data); return hash.digest('hex'); }
async function json(file) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; } }
async function writeJson(file, value) { const temporary = file + '.tmp'; await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await fs.rename(temporary, file); }
class UpdateClient {
  constructor(options) {
    this.options = options;
    this.arch = macArchitecture(options.arch || process.arch);
    this.root = path.join(options.dataDir, 'updates');
    this.configFile = path.join(this.root, 'config.json');
    this.config = { serverUrl: options.defaults.serverUrl || '', autoCheck: options.defaults.autoCheck !== false };
    this.publicKey = options.defaults.publicKey;
    this.state = { phase: 'idle', currentVersion: options.version, serverUrl: this.config.serverUrl, autoCheck: true, supported: options.supported, canInstall: false, readyToInstall: false, message: '' };
  }
  snapshot() { return { ...this.state }; }
  emit(patch) { Object.assign(this.state, patch); this.options.onState?.(this.snapshot()); return this.snapshot(); }
  async initialize() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    this.config = { ...this.config, ...await json(this.configFile) };
    if (this.config.serverUrl) this.config.serverUrl = serverUrl(this.config.serverUrl);
    let canInstall = false;
    if (this.options.supported) {
      this.options.appPath = await fs.realpath(this.options.appPath);
      canInstall = await fs.access(path.dirname(this.options.appPath), constants.W_OK).then(() => true, () => false);
    }
    this.emit({ serverUrl: this.config.serverUrl, autoCheck: this.config.autoCheck !== false, canInstall });
    const installed = await json(path.join(this.root, 'install-result.json'));
    if (installed && installed.status !== 'installed') this.emit({ phase: 'error', error: installed.message });
    const cached = await json(path.join(this.root, 'ready.json'));
    if (cached) {
      try {
        const release = decodeEnvelope(cached.envelope, this.publicKey, this.arch.arch), source = serverUrl(cached.serverUrl);
        const archive = path.join(this.root, release.archive.file);
        if (compareVersions(release.version, this.options.version) > 0 && (await fs.stat(archive)).size === release.archive.size && await hashFile(archive) === release.archive.sha256) {
          this.release = release; this.envelope = cached.envelope; this.source = source; this.archive = archive;
          this.emit({ phase: 'ready', readyToInstall: true, availableVersion: release.version, notes: release.notes, downloadedBytes: release.archive.size, totalBytes: release.archive.size, progress: 100, error: undefined });
        }
      } catch { await fs.rm(path.join(this.root, 'ready.json'), { force: true }); }
    }
    return this.snapshot();
  }
  async configure(input) {
    if (this.busy) throw new Error('更新操作进行中，请稍后修改地址。');
    const url = serverUrl(input?.serverUrl);
    if (typeof input.autoCheck !== 'boolean') throw new Error('自动检查配置无效。');
    const changed = url !== this.config.serverUrl;
    this.config = { ...this.config, serverUrl: url, autoCheck: input.autoCheck };
    if (changed) { delete this.config.previousServerUrl; this.release = undefined; this.archive = undefined; await fs.rm(path.join(this.root, 'ready.json'), { force: true }); }
    await writeJson(this.configFile, this.config);
    return this.emit({ ...(changed ? { phase: 'idle', availableVersion: undefined, readyToInstall: false, progress: undefined } : {}), serverUrl: url, autoCheck: input.autoCheck, error: undefined, message: '更新设置已保存。' });
  }
  async fetchRelease(source) {
    const response = await fetch(serverUrl(source) + '/' + releaseFeed(this.arch.arch), { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`更新服务器返回 HTTP ${response.status}。`); }
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > 150_000) throw new Error('更新清单超出大小限制。'); chunks.push(chunk); }
    const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const release = decodeEnvelope(envelope, this.publicKey, this.arch.arch);
    return { envelope, release, source };
  }
  async check() {
    if (this.busy) return this.snapshot();
    if (!this.options.supported) return this.emit({ message: '请在已安装的 Mac App 中检查更新。' });
    if (!this.config.serverUrl || !this.publicKey) return this.emit({ phase: 'error', error: '尚未配置更新服务器或发布公钥。' });
    this.busy = 'check'; this.emit({ phase: 'checking', error: undefined, message: '' });
    try {
      let result;
      try { result = await this.fetchRelease(this.config.serverUrl); }
      catch (error) {
        if (!this.config.previousServerUrl || !['TypeError', 'TimeoutError', 'AbortError'].includes(error.name)) throw error;
        result = await this.fetchRelease(this.config.previousServerUrl);
      }
      if (result.release.nextServerUrl && result.release.nextServerUrl !== this.config.serverUrl) {
        const next = serverUrl(result.release.nextServerUrl);
        try {
          const migrated = await this.fetchRelease(next);
          if (compareVersions(migrated.release.version, result.release.version) < 0) throw new Error('迁移服务器上的版本较低。');
          this.config.previousServerUrl = this.config.serverUrl; this.config.serverUrl = next; result = migrated;
        } catch { this.emit({ message: '新更新服务器暂不可达，继续使用当前服务器。' }); }
      }
      const highestSeenVersion = this.config.highestSeenVersions?.[this.arch.arch] || (this.arch.arch === 'x64' ? this.config.highestSeenVersion : undefined);
      if (highestSeenVersion && compareVersions(result.release.version, highestSeenVersion) < 0) throw new Error('服务器返回了已过时的版本清单，已拒绝降级。');
      this.config.highestSeenVersions = { ...this.config.highestSeenVersions, [this.arch.arch]: result.release.version };
      if (this.arch.arch === 'x64') this.config.highestSeenVersion = result.release.version;
      await writeJson(this.configFile, this.config);
      const ready = this.archive && this.release?.archive.sha256 === result.release.archive.sha256;
      Object.assign(this, result);
      const available = compareVersions(result.release.version, this.options.version) > 0;
      return this.emit({ phase: available ? ready ? 'ready' : 'available' : 'idle', readyToInstall: !!(available && ready), serverUrl: this.config.serverUrl, availableVersion: available ? result.release.version : undefined, notes: result.release.notes, lastCheckedAt: new Date().toISOString(), error: undefined, message: available ? '发现新版本。' : '当前已是最新版本。' });
    } catch (error) {
      return this.emit({ phase: 'error', error: ['TypeError', 'TimeoutError', 'AbortError'].includes(error.name) ? '无法连接更新服务器，请确认服务器在线且当前网络可达。' : error.message });
    } finally { this.busy = undefined; }
  }
  async download() {
    if (this.busy) throw new Error('更新操作进行中。');
    if (!this.release || compareVersions(this.release.version, this.options.version) <= 0) throw new Error('请先检查更新。');
    const release = decodeEnvelope(this.envelope, this.publicKey, this.arch.arch), archive = path.join(this.root, release.archive.file), temporary = archive + '.part';
    this.busy = 'download'; this.emit({ phase: 'downloading', readyToInstall: false, progress: 0, downloadedBytes: 0, totalBytes: release.archive.size, error: undefined });
    try {
      const response = await fetch(serverUrl(this.source) + '/files/' + encodeURIComponent(release.archive.file), { redirect: 'error', signal: AbortSignal.timeout(20 * 60_000) });
      if (response.status !== 200 || !response.body) { await response.body?.cancel(); throw new Error(`更新包下载失败（HTTP ${response.status}）。`); }
      if (response.headers.has('content-length') && Number(response.headers.get('content-length')) !== release.archive.size) { await response.body.cancel(); throw new Error('更新包大小与签名清单不一致。'); }
      const handle = await fs.open(temporary, 'w', 0o600), hash = createHash('sha256'); let size = 0, emitted = 0;
      try {
        for await (const chunk of response.body) {
          size += chunk.length; if (size > release.archive.size) throw new Error('更新包超出签名清单中的大小。');
          hash.update(chunk); let offset = 0;
          while (offset < chunk.length) { const result = await handle.write(chunk, offset, chunk.length - offset); if (!result.bytesWritten) throw new Error('无法写入更新包。'); offset += result.bytesWritten; }
          if (Date.now() - emitted > 200) { emitted = Date.now(); this.emit({ downloadedBytes: size, progress: Math.floor(size / release.archive.size * 100) }); }
        }
      } finally { await handle.close(); }
      if (size !== release.archive.size || hash.digest('hex') !== release.archive.sha256) throw new Error('更新包完整性校验失败，已拒绝安装。');
      await fs.rename(temporary, archive); this.archive = archive;
      await writeJson(path.join(this.root, 'ready.json'), { envelope: this.envelope, serverUrl: this.source });
      return this.emit({ phase: 'ready', readyToInstall: true, progress: 100, downloadedBytes: size, message: '更新包已校验，可以重启安装。' });
    } catch (error) { await fs.rm(temporary, { force: true }); return this.emit({ phase: 'error', error: error.message }); }
    finally { this.busy = undefined; }
  }
  async install() {
    if (this.busy || !this.state.readyToInstall || !this.archive || !this.options.supported) throw new Error('请先下载并校验更新包。');
    if (!this.state.canInstall) throw new Error('当前 App 所在目录不可写，请先将 App 拖入「应用程序」后再更新。');
    this.busy = 'install'; this.emit({ phase: 'preparing', error: undefined, message: '正在准备安装，完成后将重启 App。' });
    const id = randomBytes(12).toString('hex'), stage = path.join(this.root, `stage-${id}`), parent = path.dirname(this.options.appPath);
    const candidate = path.join(parent, `.Partner Agent.install-${id}.app`), backup = path.join(parent, `.Partner Agent.backup-${id}.app`);
    let prepared = false, handedOff = false, archiveTrusted = false, failure;
    try {
      const release = decodeEnvelope(this.envelope, this.publicKey, this.arch.arch);
      if (await hashFile(this.archive) !== release.archive.sha256) throw new Error('下载后的更新包已变化，请重新下载。');
      const currentOS = (await exec('/usr/bin/sw_vers', ['-productVersion'])).stdout.trim().split('.').map(Number), minimum = release.minimumMacOS.split('.').map(Number);
      if ((currentOS[0] < minimum[0]) || (currentOS[0] === minimum[0] && currentOS[1] < minimum[1])) throw new Error(`此更新需要 macOS ${release.minimumMacOS} 或更高版本。`);
      const names = (await exec('/usr/bin/unzip', ['-Z1', this.archive], { maxBuffer: 16 * 1024 * 1024 })).stdout.split('\n').filter(Boolean);
      if (!names.length || names.some(name => !name.startsWith('Partner Agent.app/') || name.split('/').some(part => part === '..' || part === '.') || name.includes('\\'))) throw new Error('更新归档目录不安全。');
      await fs.mkdir(stage, { mode: 0o700 });
      await exec('/usr/bin/ditto', ['-x', '-k', this.archive, stage], { timeout: 300_000 });
      const app = path.join(stage, 'Partner Agent.app'), plist = path.join(app, 'Contents', 'Info.plist');
      const bundleId = (await exec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist])).stdout.trim();
      const version = (await exec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist])).stdout.trim();
      const metadata = await json(path.join(app, 'Contents', 'Resources', 'app', 'package.json'));
      if (bundleId !== PRODUCT_ID || version !== release.version || metadata?.version !== release.version) throw new Error('更新包内部版本或应用身份不匹配。');
      const arch = (await exec('/usr/bin/lipo', ['-archs', path.join(app, 'Contents', 'MacOS', 'Partner Agent')])).stdout.trim();
      if (!arch.split(/\s+/).includes(this.arch.macho)) throw new Error(`此更新包不支持当前 ${this.arch.label}。`);
      const engine = path.join(app, 'Contents', 'Resources', 'app', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
      const engineArch = (await exec('/usr/bin/lipo', ['-archs', engine])).stdout.trim();
      if (!engineArch.split(/\s+/).includes(this.arch.macho)) throw new Error('更新包内的 OpenCode 与当前芯片架构不匹配。');
      await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { timeout: 120_000 });
      await exec('/usr/bin/ditto', [app, candidate], { timeout: 300_000 });
      await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', candidate], { timeout: 120_000 });
      archiveTrusted = true;
      await this.options.prepareInstall(); prepared = true;
      const helper = path.join(this.root, `install-${id}.sh`);
      await fs.copyFile(path.join(__dirname, 'install-update.sh'), helper); await fs.chmod(helper, 0o700);
      await writeJson(path.join(this.root, 'pending-install.json'), { id, version: release.version, appPath: this.options.appPath, backup });
      const child = spawn('/bin/bash', [helper, String(process.pid), this.options.appPath, candidate, backup, this.root, id, release.version, this.options.dataDir], { detached: true, stdio: 'ignore' });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref(); handedOff = true;
      this.emit({ phase: 'installing', message: '正在退出并安装更新。' });
      this.options.quit();
      return this.snapshot();
    } catch (error) { failure = error; }
    finally {
      if (!handedOff) { await fs.rm(candidate, { recursive: true, force: true }).catch(() => {}); if (prepared) await this.options.cancelInstall?.().catch(() => {}); }
      await fs.rm(stage, { recursive: true, force: true }).catch(() => {}); this.busy = undefined;
    }
    return this.emit({ phase: 'error', readyToInstall: archiveTrusted, error: failure.message });
  }
  async confirmBoot() {
    const pending = await json(path.join(this.root, 'pending-install.json'));
    if (!pending || !/^[a-f0-9]{24}$/.test(pending.id) || pending.version !== this.options.version || pending.appPath !== this.options.appPath) return;
    const previous = await json(path.join(this.root, 'last-install.json')).catch(() => undefined);
    await fs.writeFile(path.join(this.root, `ready-${pending.id}`), this.options.version, { mode: 0o600 });
    await writeJson(path.join(this.root, 'last-install.json'), pending);
    await fs.rm(path.join(this.root, 'pending-install.json'), { force: true });
    if (previous?.backup && path.dirname(previous.backup) === path.dirname(this.options.appPath) && /^\.Partner Agent\.backup-[a-f0-9]{24}\.app$/.test(path.basename(previous.backup))) await fs.rm(previous.backup, { recursive: true, force: true }).catch(() => {});
    this.emit({ phase: 'idle', availableVersion: undefined, readyToInstall: false, message: `已成功更新到 v${this.options.version}。` });
  }
}
module.exports = { UpdateClient };
