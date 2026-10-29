// Mac e2e (29 Oct 2026): a video show from the packaged app to a local MediaMTX, while the window is minimized, hidden
// and left on its own fullscreen Space. On 29 Oct Zé's Mac stopped sending video (and with it the sound) within
// seconds of the window going out of sight, and the server cut the show 60 s later. Nothing here reaches Grooveline:
// the booking API is mocked in the main process and the slot's RTMP address is the local MediaMTX.
//
// No Playwright: it attaches to the page and turns on focus emulation, which keeps a hidden page running and hid
// this bug (the first run passed on 1.6.1). The app is driven only through Node's inspector in its main process; the
// page is reached with webContents.executeJavaScript, like the app's own main code does.
// Usage: node freeze.mjs "<app executable>" <out dir>   Needs: MediaMTX on :1935 with its API on :9997,
// BlackHole as the default input with a tone playing into it. Prints ::notice lines and one RESULT line; exit 1 = fail.
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
const [EXE, OUT] = process.argv.slice(2);
const KEY = 'zdb-test1234';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const note = (t, m) => console.log(`::notice title=${t}::${String(m).replace(/\n/g, ' ').slice(0, 900)}`);
fs.mkdirSync(OUT, { recursive: true });

// Start the app with the inspector on its main process and return eval(expr) → value (promises awaited).
async function launch() {
  const proc = spawn(EXE, ['--inspect=127.0.0.1:9339', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let errText = '';
  const wsUrl = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('no inspector URL: ' + errText.slice(-300))), 30000);
    proc.stderr.on('data', d => { errText += d; const m = errText.match(/ws:\/\/[^\s]+/); if (m) { clearTimeout(t); res(m[0]); } });
  });
  proc.stdout.resume();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = m => { const j = JSON.parse(m.data); if (j.id && pending.has(j.id)) { pending.get(j.id)(j); pending.delete(j.id); } };
  const send = (method, params) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable', {});
  const evalMain = async expr => {
    const r = await send('Runtime.evaluate', { expression: `(async () => { const electron = process.mainModule.require('electron'); ${expr} })()`, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  // Code for the page, run by main (the window that is not our test's "other" window).
  const evalPage = code => evalMain(`const w = electron.BrowserWindow.getAllWindows().find(b => !b._e2eOther); return w.webContents.executeJavaScript(${JSON.stringify(code)});`);
  const quit = async () => { try { await evalMain('electron.app.exit(0)'); } catch {} ws.close(); await sleep(1500); try { proc.kill(); } catch {} };
  return { proc, evalMain, evalPage, quit };
}
const waitFor = async (fn, ms) => { const t = Date.now() + ms; while (Date.now() < t) { try { if (await fn()) return true; } catch {} await sleep(500); } return false; };

// First start only to learn where this build keeps its config; then a clean config and the real start.
let a = await launch();
await waitFor(() => a.evalMain('return electron.app.isReady()'), 30000);
const userData = await a.evalMain("return electron.app.getPath('userData')");
const version = await a.evalMain('return electron.app.getVersion()');
await a.quit();
fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ audioOnly: false, volume: 100, lastSeenVersion: version, recordingFolder: OUT, profiles: [] }));

a = await launch();
const ready = await waitFor(() => a.evalPage("(document.getElementById('log-output')?.textContent || '').includes('Ready.')"), 60000);
if (!ready) { note('verdict', 'the app never logged Ready.'); await a.quit(); process.exit(1); }
await sleep(3000);

// The booking API, mocked in main (same answers as slot-mock.mjs), then the page signs in to it.
const now = Date.now(), slot = { start: new Date(now - 5 * 60e3).toISOString(), end: new Date(now + 60 * 60e3).toISOString() };
await a.evalMain(`
  const { ipcMain } = electron; const s = ${JSON.stringify(slot)}; const date = () => new Date().toUTCString();
  for (const ch of ['api-me', 'api-bookings', 'api-credentials']) ipcMain.removeHandler(ch);
  ipcMain.handle('api-me', async () => ({ status: 200, date: date(), body: { dj_name: 'testdj', email: 'test@example.com', tier: 'pro' } }));
  ipcMain.handle('api-bookings', async () => ({ status: 200, date: date(), body: { bookings: [{ id: 'bk-e2e', slot_start: s.start, slot_end: s.end, status: 'confirmed', stream_type: 'rtmp', mount_point: '/e2e' }] } }));
  ipcMain.handle('api-credentials', async () => ({ status: 200, date: date(), body: { server: '127.0.0.1:18999', port: 8000, mount_point: '/e2e', username: 'source', password: 'smokepw123',
    slot_start: s.start, slot_end: s.end, stream_type: 'rtmp', stream_key: '${KEY}', rtmp_url: 'rtmp://127.0.0.1:1935/live/${KEY}' } }));
  return true;`);
await a.evalPage(`(async () => { acctToken = 'fake-token-123456'; cfg._acctToken = acctToken; acctUser = { dj_name: 'testdj', email: 'test@example.com' }; acctShowLoggedIn(); await acctFetchBookings(); refreshUI(); return true; })()`);
await sleep(5000);
const status = () => a.evalPage("document.getElementById('stat-status').textContent.trim()");
const win = body => a.evalMain(`const x = electron.BrowserWindow.getAllWindows().find(b => !b._e2eOther); ${body}; return true;`);

// MediaMTX's own count of the bytes it received for the show's path.
async function mtx() {
  for (const u of [`http://127.0.0.1:9997/v3/paths/get/live/${KEY}`, `http://127.0.0.1:9997/v3/paths/get/${encodeURIComponent('live/' + KEY)}`]) {
    try { const r = await fetch(u); if (r.ok) { const j = await r.json(); return { ready: !!j.ready, bytes: j.bytesReceived || 0 }; } } catch {}
  }
  return { ready: false, bytes: 0 };
}

await a.evalPage("document.getElementById('btn-go-live').click(); true");
let st = '';
for (let i = 0; i < 40 && !/ON AIR/i.test(st); i++) { await sleep(1000); st = await status(); }
note('go-live', `status "${st}" after GO LIVE · ${JSON.stringify(await mtx())}`);
await sleep(10000);

const samples = [];
let phase = 'live';
const sampler = setInterval(async () => { const m = await mtx(); samples.push({ phase, ...m }); }, 5000);
async function run(name, enter, secs, leave) { phase = name; await enter(); await sleep(secs * 1000); phase = name + '-leave'; await leave(); await sleep(8000); }
const none = async () => {};
await run('visible', none, 30, none);
await run('minimized', () => win('x.minimize()'), 40, () => win('x.restore()'));
await run('hidden', () => win('x.hide()'), 40, () => win('x.show()'));
await run('fullscreen-space', async () => {
  await win('x.setFullScreen(true)'); await sleep(4000);
  await a.evalMain("const o = new electron.BrowserWindow({ width: 600, height: 400, backgroundColor: '#fff' }); o._e2eOther = true; o.loadURL('data:text/html,other'); o.setFullScreen(true); o.focus(); return true;");
}, 40, async () => {
  await a.evalMain('electron.BrowserWindow.getAllWindows().filter(b => b._e2eOther).forEach(b => b.destroy()); return true;');
  await sleep(2000); await win('x.setFullScreen(false)');
});
// The video server restarts mid-show (what a dropped connection looks like): the app must notice and reconnect.
// 1.6.1 kept recording locally, said ON AIR, and the server got nothing until STOP.
let reconnect = null;
if (process.env.MTX_PID_FILE) {
  phase = 'server-restart';
  const pid = +fs.readFileSync(process.env.MTX_PID_FILE, 'utf8');
  try { process.kill(pid); } catch {}
  await sleep(3000);
  const m = spawn(process.env.MTX_BIN, [process.env.MTX_CONF], { stdio: ['ignore', fs.openSync(process.env.MTX_LOG, 'a'), fs.openSync(process.env.MTX_LOG, 'a')], detached: true });
  fs.writeFileSync(process.env.MTX_PID_FILE, String(m.pid)); m.unref();
  const t0 = Date.now(); let back = false, b0 = null;
  const statuses = new Set();
  while (Date.now() - t0 < 75000) {
    statuses.add(await status());
    const x = await mtx();
    if (x.ready) { if (b0 === null) b0 = x.bytes; else if (x.bytes - b0 > 100 * 1024) { back = true; break; } }
    await sleep(2500);
  }
  reconnect = { back, secs: Math.round((Date.now() - t0) / 1000), statuses: [...statuses] };
  phase = 'after-restart';
  await sleep(15000);
}
clearInterval(sampler);
const finalStatus = await status();
await a.evalPage("document.getElementById('btn-go-live').click(); true");
await sleep(6000);

// Per phase: the smallest growth between two samples 5 s apart. A stalled show sends ~0.
const byPhase = {};
for (let i = 1; i < samples.length; i++) (byPhase[samples[i].phase] ||= []).push(Math.round((samples[i].bytes - samples[i - 1].bytes) / 1024));
const summary = Object.fromEntries(Object.entries(byPhase).map(([p, v]) => [p, { minKB5s: Math.min(...v), maxKB5s: Math.max(...v), n: v.length }]));
const logFile = path.join(userData, 'logs', 'broadcaster.log');
const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
const drops = log.split('\n').filter(l => /\[mac video\]/.test(l)).map(l => +(l.match(/dropped audio (\d+)/) || [0, 0])[1]);
const problems = log.split('\n').filter(l => /Slave muxer|End of file|Broken pipe|video stopped|lost the connection/i.test(l)).slice(0, 5).map(l => l.slice(0, 160));
const stalled = Object.entries(summary).filter(([p, s]) => !p.endsWith('-leave') && p !== 'server-restart' && s.minKB5s < 20).map(([p]) => p);
if (reconnect && !reconnect.back) stalled.push('server-restart (no reconnect)');
for (const [p, s] of Object.entries(summary)) if (!p.endsWith('-leave')) note('phase ' + p, `min ${s.minKB5s} kB / 5 s, max ${s.maxKB5s} (${s.n} samples)`);
note('audio', `sox dropped per 10 s: ${drops.join(',') || 'no [mac video] lines'} · status at the end "${finalStatus}" · ${problems.join(' | ') || 'no muxer errors'}`);
if (reconnect) note('server restart', `${reconnect.back ? 'back on the server' : 'NOT back'} after ${reconnect.secs} s · app said: ${reconnect.statuses.join(' / ')}`);
note('verdict', stalled.length ? `STALLED in: ${stalled.join(', ')}` : 'video kept flowing in every phase');
console.log('RESULT ' + JSON.stringify({ version, summary, drops, finalStatus, problems, reconnect, stalled }));
if (log) fs.writeFileSync(path.join(OUT, 'app-log.txt'), log);
await a.quit();
process.exit(stalled.length ? 1 : 0);
