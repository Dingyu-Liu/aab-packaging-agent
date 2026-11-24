const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const { mkdirSync, appendFileSync, readFileSync } = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { MAC_ARCHITECTURES } = require('./macos-arch.cjs');
const { UpdateClient } = require('./update-client.cjs');
const desktopToken = randomBytes(32).toString('base64url');
const root = path.resolve(__dirname, '..');
const { version } = require(path.join(root, 'package.json'));
app.setName('AAB助手');
const dataDir = path.resolve(process.env.PARTNER_AGENT_DATA_DIR || (app.isPackaged ? path.join(app.getPath('appData'), 'Partner Agent Public') : path.join(root, '.local-data')));
mkdirSync(path.join(dataDir, 'desktop'), { recursive: true, mode: 0o700 });
app.setPath('userData', path.join(dataDir, 'desktop'));
let port = Number(process.env.PARTNER_AGENT_PORT || (app.isPackaged ? 0 : 4317));
let base = `http://127.0.0.1:${port}`;
let backend;
let window;
let quitting = false;
let updater;
function log(text) {
  const directory = path.join(dataDir, 'logs');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  appendFileSync(path.join(directory, 'desktop.log'), `${new Date().toISOString()} ${text}\n`, { mode: 0o600 });
}
async function healthy() {
  if (!port) return false;
  try {
    const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(700) });
    const body = await response.json();
    return response.ok && body.ok === true && body.version === version && body.role === 'local';
  } catch { return false; }
}
async function startBackend() {
  if (!app.isPackaged && await healthy()) return;
  const node = app.isPackaged ? path.join(process.resourcesPath, 'runtime', 'bin', 'node') : (process.env.PARTNER_AGENT_NODE || process.execPath);
  const env = {
    ...process.env,
    PARTNER_AGENT_ROLE: 'local',
    PARTNER_AGENT_HOST: '127.0.0.1',
    PARTNER_AGENT_PORT: String(port),
    PARTNER_AGENT_DATA_DIR: dataDir,
    PARTNER_AGENT_DESKTOP_TOKEN: desktopToken,
    PATH: [path.dirname(node), ...(process.arch === 'arm64' ? ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin'] : ['/usr/local/bin', '/opt/homebrew/bin', '/opt/homebrew/sbin']), '/usr/bin', '/bin', '/usr/sbin', '/sbin', process.env.PATH || ''].join(path.delimiter),
  };
  if (app.isPackaged) {
    delete env.PARTNER_AGENT_REGISTRY_URL;
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
  }
  if (node === process.execPath) env.ELECTRON_RUN_AS_NODE = '1';
  else delete env.ELECTRON_RUN_AS_NODE;
  const args = app.isPackaged ? [path.join(root, 'server', 'index.js')] : ['--import', 'tsx', path.join(root, 'server', 'index.ts')];
  backend = spawn(node, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '', output = '', launchError;
  backend.stderr.on('data', chunk => { errors = (errors + chunk.toString()).slice(-5000); log(chunk.toString().trimEnd()); });
  backend.stdout.on('data', chunk => {
    output = (output + chunk.toString()).slice(-5000);
    const ready = output.match(/Partner Agent ready \(local\): http:\/\/127\.0\.0\.1:(\d+)/);
    if (ready) { port = Number(ready[1]); base = `http://127.0.0.1:${port}`; }
    log(chunk.toString().trimEnd());
  });
  backend.on('error', error => { launchError = error; });
  backend.on('exit', (code, signal) => {
    if (window && !quitting) {
      log(`本地服务退出：${code ?? signal}`);
      dialog.showErrorBox('AAB助手本地服务已停止', errors || '请重新打开 App。');
      app.quit();
    }
  });
  for (let i = 0; i < 120; i++) {
    if (launchError || backend.exitCode !== null) throw new Error(launchError?.message || errors || '本地服务未能启动。');
    if (await healthy()) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`本地服务启动超时。日志：${path.join(dataDir, 'logs', 'desktop.log')}`);
}
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(async () => {
    try {
      await startBackend();
      let defaults = {};
      try { defaults = JSON.parse(readFileSync(path.join(__dirname, 'update-config.json'), 'utf8')); } catch {}
      async function updateHandoff(action) {
        const response = await fetch(`${base}/api/desktop/update/${action}`, { method: 'POST', headers: { 'X-Partner-Agent': 'local', 'X-Partner-Desktop-Token': desktopToken, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || '无法准备更新。');
      }
      updater = new UpdateClient({ version, dataDir, defaults, appPath: path.resolve(process.resourcesPath, '..', '..'), arch: process.arch, supported: false, onState: state => { if (window && !window.isDestroyed()) window.webContents.send('partner:update:state', state); }, prepareInstall: () => updateHandoff('prepare'), cancelInstall: () => updateHandoff('cancel'), quit: () => app.quit() });
      try { await updater.initialize(); } catch (error) { log(`更新初始化失败：${error.message}`); updater.emit({ phase: 'error', error: error.message }); }
      for (const [name, handler] of Object.entries({ status: () => updater.snapshot(), configure: input => updater.configure(input), check: () => updater.check(), download: () => updater.download(), install: () => updater.install() })) {
        ipcMain.handle(`partner:update:${name}`, (event, input) => {
          if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || new URL(event.senderFrame.url).origin !== base) throw new Error('更新操作来源无效。');
          return handler(input);
        });
      }
      window = new BrowserWindow({ width: 1460, height: 960, minWidth: 1050, minHeight: 700, title: 'AAB助手', backgroundColor: '#0b1830', autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
      window.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) void shell.openExternal(url); return { action: 'deny' }; });
      window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(base + '/')) event.preventDefault(); });
      Menu.setApplicationMenu(Menu.buildFromTemplate([
        { label: 'AAB助手', submenu: [{ role: 'about' }, { label: '检查更新…', click: () => { window?.webContents.send('partner:update:open'); void updater?.check(); } }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' }, { role: 'quit' }] },
        { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
        { label: '视图', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] }
      ]));
      await window.loadURL(base);
      await updater.confirmBoot();
      const checkUpdates = () => { if (updater.state.autoCheck && !quitting) void updater.check(); };
      const firstCheck = setTimeout(checkUpdates, 5000); firstCheck.unref();
      const updateInterval = setInterval(checkUpdates, 4 * 60 * 60_000); updateInterval.unref();
      log(`Partner Agent desktop ready (v${version}, ${process.arch}): ${base}`);
      console.log(`Partner Agent desktop ready (v${version}, ${process.arch}): ${base}`);
    } catch (error) {
      log(error instanceof Error ? error.stack || error.message : String(error));
      dialog.showErrorBox('AAB助手启动失败', error instanceof Error ? error.message : String(error));
      app.quit();
    }
  });
  app.on('window-all-closed', () => app.quit());
  process.on('SIGTERM', () => app.quit());
  process.on('SIGINT', () => app.quit());
  app.on('before-quit', event => {
    quitting = true;
    if (!backend || backend.exitCode !== null || backend.signalCode !== null) return;
    event.preventDefault();
    const child = backend;
    backend = undefined;
    const timer = setTimeout(() => { child.kill('SIGKILL'); app.quit(); }, 5000);
    timer.unref();
    child.once('exit', () => { clearTimeout(timer); app.quit(); });
    child.kill('SIGTERM');
  });
}
