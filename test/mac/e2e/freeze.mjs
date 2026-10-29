// Mac e2e (29 Oct 2026): a video show from the packaged app to a local MediaMTX, while the window is minimized, hidden
// and left on its own fullscreen Space. On 29 Oct Zé's Mac stopped sending video (and with it the sound) within
// seconds of the window going out of sight, and the server cut the show 60 s later. Nothing here reaches Grooveline:
// the booking API is mocked in the main process and the slot's RTMP address is the local MediaMTX.
// Usage: node freeze.mjs "<app executable>" <out dir>   Needs: MediaMTX on :1935 with its API on :9997,
// BlackHole as the default input with a tone playing into it. Prints ::notice lines and one RESULT line; exit 1 = fail.
import { _electron } from 'playwright-core';
import fs from 'fs';
import path from 'path';
import { mockSlot } from './slot-mock.mjs';
const [EXE, OUT] = process.argv.slice(2);
const KEY = 'zdb-test1234';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const note = (t, m) => console.log(`::notice title=${t}::${String(m).replace(/\n/g, ' ').slice(0, 900)}`);
const args = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];
fs.mkdirSync(OUT, { recursive: true });

// First launch only to learn where this build keeps its config, then write a clean one and start for real.
let app = await _electron.launch({ executablePath: EXE, args });
const userData = await app.evaluate(({ app }) => app.getPath('userData'));
const version = await app.evaluate(({ app }) => app.getVersion());
await app.close();
fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ audioOnly: false, volume: 100, lastSeenVersion: version, recordingFolder: OUT, profiles: [] }));

app = await _electron.launch({ executablePath: EXE, args });
const w = await app.firstWindow();
const errs = []; w.on('pageerror', e => errs.push(e.message));
const logText = () => w.evaluate(() => document.getElementById('log-output').textContent);
await w.waitForFunction(() => (document.getElementById('log-output')?.textContent || '').includes('Ready.'), null, { timeout: 60000, polling: 250 });
await sleep(3000);
await mockSlot(app, w, { type: 'rtmp', mount: '/e2e', rtmpUrl: `rtmp://127.0.0.1:1935/live/${KEY}`, startMin: -5, endMin: 60 });
await sleep(4000);
const status = () => w.evaluate(() => document.getElementById('stat-status').textContent.trim());
const win = fn => app.evaluate(({ BrowserWindow }, fn) => { const x = BrowserWindow.getAllWindows().find(b => !b._e2eOther); return eval(fn)(x, BrowserWindow); }, fn.toString());

// MediaMTX's own count of bytes it received for the show's path.
async function mtx() {
  for (const u of [`http://127.0.0.1:9997/v3/paths/get/live/${KEY}`, `http://127.0.0.1:9997/v3/paths/get/${encodeURIComponent('live/' + KEY)}`]) {
    try { const r = await fetch(u); if (r.ok) { const j = await r.json(); return { ready: !!j.ready, bytes: j.bytesReceived || 0 }; } } catch {}
  }
  return { ready: false, bytes: 0 };
}

await w.evaluate(() => document.getElementById('btn-go-live').click());
let st = '';
for (let i = 0; i < 40 && !/ON AIR/i.test(st); i++) { await sleep(1000); st = await status(); }
note('go-live', `status "${st}" after GO LIVE · ${JSON.stringify(await mtx())}`);
await sleep(10000);

const samples = [];
let phase = 'live';
const sampler = setInterval(async () => { const m = await mtx(); samples.push({ t: Date.now(), phase, ...m }); }, 5000);
async function run(name, enter, secs, leave) { phase = name; await enter(); await sleep(secs * 1000); phase = name + '-leave'; await leave(); await sleep(8000); }
const none = async () => {};
await run('visible', none, 30, none);
await run('minimized', () => win(x => x.minimize()), 40, () => win(x => x.restore()));
await run('hidden', () => win(x => x.hide()), 40, () => win(x => x.show()));
await run('fullscreen-space', async () => {
  await win(x => x.setFullScreen(true)); await sleep(4000);
  await app.evaluate(({ BrowserWindow }) => { const o = new BrowserWindow({ width: 600, height: 400, backgroundColor: '#fff' }); o._e2eOther = true; o.loadURL('data:text/html,other'); o.setFullScreen(true); o.focus(); });
}, 40, async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(b => b._e2eOther).forEach(b => b.destroy()));
  await sleep(2000); await win(x => x.setFullScreen(false));
});
clearInterval(sampler);
const finalStatus = await status();
await w.evaluate(() => document.getElementById('btn-go-live').click());
await sleep(6000);

// Per phase: the smallest growth between two samples 5 s apart. A stalled show sends ~0.
const byPhase = {};
for (let i = 1; i < samples.length; i++) {
  const p = samples[i].phase, kb = (samples[i].bytes - samples[i - 1].bytes) / 1024;
  (byPhase[p] ||= []).push(Math.round(kb));
}
const summary = Object.fromEntries(Object.entries(byPhase).map(([p, v]) => [p, { minKB5s: Math.min(...v), maxKB5s: Math.max(...v), n: v.length }]));
const log = await logText();
const macLines = log.split('\n').filter(l => /\[mac video\]/.test(l));
const drops = macLines.map(l => +(l.match(/dropped audio (\d+)/) || [0, 0])[1]);
const problems = log.split('\n').filter(l => /Slave muxer|End of file|Broken pipe|video stopped|lost the connection/i.test(l)).slice(0, 5);
const stalled = Object.entries(summary).filter(([p, s]) => !p.endsWith('-leave') && s.minKB5s < 20).map(([p]) => p);
for (const [p, s] of Object.entries(summary)) if (!p.endsWith('-leave')) note('phase ' + p, `min ${s.minKB5s} kB / 5 s, max ${s.maxKB5s} (${s.n} samples)`);
note('audio', `sox dropped per 10 s: ${drops.join(',')} · status at the end "${finalStatus}" · ${problems.join(' | ') || 'no muxer errors'}`);
note('verdict', stalled.length ? `STALLED in: ${stalled.join(', ')}` : 'video kept flowing in every phase');
console.log('RESULT ' + JSON.stringify({ version, summary, drops, finalStatus, problems, errs: errs.slice(0, 3), stalled }));
fs.writeFileSync(path.join(OUT, 'app-log.txt'), log);
await app.close();
process.exit(stalled.length ? 1 : 0);
