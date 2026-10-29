// Mac CI checks in a plain Electron (the app's version), with Chromium's fake camera. Prints one "RESULT {json}" line.
// GL_MODE=throttle: does video keep flowing while the window is minimized, hidden or covered?
//   GL_LOOP = rvfc | timer | direct, GL_FLAGS=1 adds the no-background-throttling switches + powerSaveBlocker.
// GL_MODE=enc: H264 in the page (enc.html), keyframes checked with GL_FFMPEG.
const { app, BrowserWindow, powerSaveBlocker } = require('electron');
const fs = require('fs'), path = require('path'), os = require('os');
const { spawnSync } = require('child_process');
const mode = process.env.GL_MODE || 'throttle', loop = process.env.GL_LOOP || 'rvfc', flags = process.env.GL_FLAGS === '1';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const done = r => { console.log('RESULT ' + JSON.stringify(r)); app.exit(0); };
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
if (flags) {
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
}
setTimeout(() => done({ mode, loop, flags, error: 'timeout' }), 300000);

async function throttle() {
  if (flags) powerSaveBlocker.start('prevent-app-suspension');
  const w = new BrowserWindow({ width: 800, height: 600, x: 80, y: 80, webPreferences: flags ? { backgroundThrottling: false } : {} });
  await w.loadFile(path.join(__dirname, 'throttle.html'), { query: { loop } });
  const label = await w.webContents.executeJavaScript('start()');
  const snap = () => w.webContents.executeJavaScript('({ ...st })');
  const phases = {};
  const phase = async (name, enter, leave) => {
    await enter(); await sleep(3000);
    const a = await snap(); await sleep(12000); const b = await snap();
    phases[name] = { draws: +((b.draws - a.draws) / 12).toFixed(1), chunks: +((b.chunks - a.chunks) / 12).toFixed(1), kbps: Math.round((b.bytes - a.bytes) * 8 / 12000) };
    await leave(); await sleep(2000);
  };
  const none = async () => {};
  await phase('visible', none, none);
  await phase('minimized', async () => w.minimize(), async () => w.restore());
  await phase('hidden', async () => w.hide(), async () => w.show());
  let cover;
  await phase('covered', async () => {
    cover = new BrowserWindow({ ...w.getBounds(), backgroundColor: '#ffffff' });
    await cover.loadURL('data:text/html,<body style="background:#fff">cover</body>'); cover.focus();
  }, async () => cover.destroy());
  await phase('again', none, none);
  done({ mode, loop, flags, label, phases });
}

async function enc() {
  const ff = process.env.GL_FFMPEG;
  const out = path.join(os.tmpdir(), 'gl-enc-out'); fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out);
  const w = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  await w.loadFile(path.join(__dirname, 'enc.html'));
  const r = await w.webContents.executeJavaScript('runCheck()');
  for (const t of r.tests) {
    if (!t.file) continue;
    const f = path.join(out, t.name); fs.writeFileSync(f, Buffer.from(t.file)); delete t.file;
    if (!ff || t.name.endsWith('.h264')) continue;
    const e = spawnSync(ff, ['-hide_banner', '-skip_frame', 'nokey', '-i', f, '-vf', 'showinfo', '-an', '-f', 'null', '-'], { encoding: 'utf8' }).stderr || '';
    t.keyframes = [...e.matchAll(/pts_time:([\d.]+)/g)].map(m => +(+m[1]).toFixed(1));
  }
  done({ mode, ...r });
}
app.whenReady().then(() => (mode === 'enc' ? enc() : throttle())).catch(e => done({ mode, loop, flags, error: String(e) }));
