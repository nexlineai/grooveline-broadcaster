// One real-Mac pass for a Broadcaster release (29 Oct 2026): only what GitHub's Macs can't test. A real camera and
// microphone, macOS asking for them the first time, a real fullscreen-Space switch, minimize, cover, the load on this
// Mac, and sound against picture (a clap with the phone torch). Writes its own report.
// Runs on the app's own engine, nothing to install:
//   ELECTRON_RUN_AS_NODE=1 "/Applications/Grooveline Broadcaster.app/Contents/MacOS/Grooveline Broadcaster" real-pass.js [report dir]
const fs = require('fs'), path = require('path'), os = require('os'), readline = require('readline');
const { execFileSync, spawnSync, spawn } = require('child_process');
const APP = '/Applications/Grooveline Broadcaster.app', RES = path.join(APP, 'Contents/Resources');
const FFMPEG = process.env.GL_FFMPEG || path.join(RES, 'ffmpeg'); // each app carries its own architecture's tools (1.6.3)
// userData follows package.json "name": electron-builder keeps build.productName out of the packaged package.json.
let LOG = path.join(os.homedir(), 'Library/Application Support/grooveline-broadcaster/logs/broadcaster.log');
const OUT = process.argv[2] || path.join(os.homedir(), 'Desktop');
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
const report = [], phases = [], samples = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(r => rl.question(q, a => r(a.trim())));
const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; } };
const say = s => { console.log(s); report.push(s); };
async function countdown(secs, text) {
  for (let s = secs; s > 0; s -= 5) { process.stdout.write(`\r  ${text}: ${s} s left   `); await sleep(Math.min(5, s) * 1000); }
  process.stdout.write('\r' + ' '.repeat(70) + '\r');
}
const phase = name => phases.push({ name, at: Date.now() });

// Every 5 s: which app is in front, CPU of the app's page and of ffmpeg, bytes waiting to go to the server.
function sample() {
  const front = (sh('lsappinfo', ['info', '-only', 'name', sh('lsappinfo', ['front']).trim()]).match(/"LSDisplayName"="([^"]*)"/) || [])[1] || '?';
  const ps = sh('ps', ['-Ao', 'pcpu=,command=']).split('\n');
  const cpu = re => ps.filter(l => re.test(l)).reduce((a, l) => a + parseFloat(l), 0);
  const sendQ = sh('netstat', ['-an', '-p', 'tcp']).split('\n').filter(l => /\.1935\s+ESTABLISHED/.test(l)).map(l => +l.trim().split(/\s+/)[2])[0];
  samples.push({ t: Date.now(), front, page: cpu(/Grooveline Broadcaster Helper \(Renderer\)/), ffmpeg: cpu(/Contents\/Resources\/ffmpeg /), sendQ: sendQ ?? null });
}

// [mac video] lines of the app's log since the start: ffmpeg time, speed, sox drops.
function macVideoLines(since) {
  if (!fs.existsSync(LOG)) return [];
  return fs.readFileSync(LOG, 'utf8').split('\n').map(l => {
    const m = l.match(/^(\S+) .*\[mac video\] ffmpeg time=(\S+) speed=(\S+) · sox dropped audio (\d+)/);
    return m && { t: Date.parse(m[1]), time: m[2], speed: parseFloat(m[3]) || 0, drops: +m[4] };
  }).filter(x => x && x.t >= since);
}

// Sound against picture: the torch switching on makes the picture brighter, the clap makes the sound peak.
function avOffset(file) {
  const ffErr = args => spawnSync(FFMPEG, ['-hide_banner', '-i', file, ...args, '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 64 << 20 }).stderr || '';
  const a = ffErr(['-vn', '-af', 'astats=metadata=1:reset=1:length=0.02,ametadata=print:key=lavfi.astats.Overall.Peak_level']);
  const v = ffErr(['-an', '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG']);
  const series = (txt, key) => { const out = []; let t = null;
    for (const l of txt.split('\n')) { const m = l.match(/pts_time:([\d.]+)/); if (m) t = +m[1]; const k = l.match(new RegExp(key + '=(-?[\\d.]+|-inf)')); if (k && t !== null) out.push([t, k[1] === '-inf' ? -120 : +k[1]]); }
    return out; };
  const aud = series(a, 'lavfi.astats.Overall.Peak_level'), vid = series(v, 'lavfi.signalstats.YAVG');
  const edges = (s, jump, gap) => { const e = []; for (let i = 1; i < s.length; i++) if (s[i][1] - s[i - 1][1] > jump && (!e.length || s[i][0] - e[e.length - 1] > gap)) e.push(s[i][0]); return e; };
  const claps = edges(aud, 20, 1.5), flashes = edges(vid, 15, 1.5);
  const pairs = claps.map(c => { const f = flashes.reduce((b, x) => Math.abs(x - c) < Math.abs(b - c) ? x : b, Infinity); return Math.abs(f - c) < 1 ? f - c : null; }).filter(x => x !== null);
  return { claps: claps.length, flashes: flashes.length, offsetsMs: pairs.map(x => Math.round(x * 1000)) };
}

(async () => {
  if (process.env.GL_AV_TEST) { console.log(JSON.stringify(avOffset(process.env.GL_AV_TEST))); process.exit(0); } // self-test of the analysis
  say(`Grooveline Broadcaster real-Mac pass · ${new Date().toString()}`);
  const plist = path.join(APP, 'Contents/Info.plist');
  const ver = (sh('defaults', ['read', plist, 'CFBundleShortVersionString']) || '?').trim();
  say(`App ${ver} · macOS ${sh('sw_vers', ['-productVersion']).trim()} · ${sh('sysctl', ['-n', 'hw.model']).trim()} · ${sh('sysctl', ['-n', 'machdep.cpu.brand_string']).trim()}`);
  say(`ffmpeg: ${FFMPEG} (${sh('file', ['-b', FFMPEG]).trim()})`); // file, not lipo: lipo is a stub on a Mac without developer tools

  console.log('\n1) Camera and microphone permission, as on a new Mac. Quit Grooveline Broadcaster first (Cmd-Q).');
  await ask('   Press Enter when it is quit… ');
  sh('tccutil', ['reset', 'Camera', 'org.grooveline.broadcaster']); sh('tccutil', ['reset', 'Microphone', 'org.grooveline.broadcaster']);
  console.log('   Now open the app. macOS asks for the microphone, then the camera: allow both.');
  const prev = await ask('   Does the preview show your camera WITHOUT reopening the app? (y/n) ');
  say(`Permission on first open: camera preview ${/^y/i.test(prev) ? 'came up' : 'DID NOT come up'} without reopening`);
  // The verdict below reads this log, so find out now, not after the run.
  while (!fs.existsSync(LOG)) {
    const dir = await ask(`   Can't find the app's log: ${LOG}\n   In the app, SETTINGS says "Log files: ...". Paste that folder here (or just Enter to go on without it): `);
    if (!dir) break;
    LOG = path.join(dir.replace(/^~/, os.homedir()), 'broadcaster.log');
  }
  say(`App log: ${LOG}${fs.existsSync(LOG) ? '' : ' (NOT FOUND)'}`);

  console.log('\n2) In the app: ON AIR › Stream check › Start video check. Then press "Watch" and copy the link it opens.');
  const link = await ask('   Paste the Watch link here (or just Enter to skip the sound/picture check): ');
  const key = (link.match(/key=(vcheck-[0-9a-f]{20})/) || [])[1];
  if (key) console.log(`   iPhone, same time: open https://preview-player-polish.grooveline-platform.pages.dev/?key=${key}\n   and tap play. Check: fullscreen works, no volume slider, the timer counts, pause works.`);
  await ask('   Press Enter once the video check says our server sees you… ');
  const t0 = Date.now();
  const timer = setInterval(sample, 5000); sample();

  console.log('\n3) Keep the Grooveline window visible and in front.');
  phase('visible'); await countdown(60, 'window visible');
  console.log('4) Open another app and make it fullscreen (green button), so Grooveline is on another Space. Stay there.');
  await ask('   Press Enter when the other app is fullscreen… ');
  phase('other Space'); await countdown(120, 'stay on the other app');
  console.log('5) Come back to Grooveline and minimize its window (yellow button). Then come back to this Terminal.');
  await ask('   Press Enter when it is minimized… ');
  phase('minimized'); await countdown(60, 'keep it minimized');
  console.log('6) Restore the window, then cover it completely with another window (a browser window, maximized).');
  await ask('   Press Enter when it is covered… ');
  phase('covered'); await countdown(60, 'keep it covered');
  console.log('7) Bring Grooveline back in front.');
  phase('back'); await countdown(20, 'window visible');

  let av = null;
  if (key) {
    console.log('8) Sound against picture. Sit in front of the camera with your phone torch OFF.');
    console.log('   When asked: switch the torch ON pointing at the camera and CLAP at the same moment, then torch OFF.');
    console.log('   Three times, about 4 seconds apart.');
    await ask('   Press Enter, then start within 5 s… ');
    const clip = path.join(os.tmpdir(), `gl-clap-${stamp}.ts`);
    phase('clap');
    const rec = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', `https://stream.grooveline.org/live/${key}/index.m3u8`, '-t', '35', '-c', 'copy', clip]);
    await countdown(35, 'torch on + clap, 3 times');
    await new Promise(r => rec.on('close', r));
    av = fs.existsSync(clip) ? avOffset(clip) : { error: 'nothing recorded from the stream' };
  }
  clearInterval(timer);
  console.log('9) Press STOP in the app (the video check).');
  await ask('   Press Enter when stopped… ');
  await sleep(2000);

  // Report per phase.
  const mv = macVideoLines(t0);
  const ends = phases.map((p, i) => [p.name, p.at, (phases[i + 1] || { at: Date.now() }).at]);
  say('\nPhase            front app (most)     page CPU  ffmpeg CPU  speed     ffmpeg time moved   sox drops');
  for (const [name, a, b] of ends) {
    const ss = samples.filter(s => s.t >= a && s.t < b), ll = mv.filter(x => x.t >= a && x.t < b);
    const front = Object.entries(ss.reduce((m, s) => (m[s.front] = (m[s.front] || 0) + 1, m), {})).sort((x, y) => y[1] - x[1])[0]?.[0] || '?';
    const med = arr => { const v = [...arr].sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : 0; };
    const moved = ll.length > 1 ? new Set(ll.map(x => x.time)).size === ll.length : null;
    say(`${name.padEnd(16)} ${front.slice(0, 20).padEnd(20)} ${String(Math.round(med(ss.map(s => s.page)))).padStart(5)} %  ${String(Math.round(med(ss.map(s => s.ffmpeg)))).padStart(6)} %  ${(med(ll.map(x => x.speed)) || 0).toFixed(2).padStart(5)}x   ${moved === null ? '?' : moved ? 'yes, every 10 s' : 'NO: STALLED'}   ${ll.map(x => x.drops).join(',')}`);
  }
  const first = mv.slice(0, 2).map(x => x.drops);
  say(`\nStart-up: sox dropped ${first.join(' + ') || '?'} buffers in the first 20 s (1.6.1 on this Mac: 30–80).`);
  if (av) say(`Sound vs picture: ${av.error || `${av.claps} claps, ${av.flashes} torch flashes, offsets ${av.offsetsMs.join(', ') || 'none paired'} ms (positive = picture after sound; within ±150 ms is fine)`}`);
  const inPhase = ([, a, b]) => mv.filter(x => x.t >= a && x.t < b);
  const stalled = ends.some(e => { const ll = inPhase(e); return ll.length > 1 && new Set(ll.map(x => x.time)).size < ll.length; });
  const blind = ends.filter(e => inPhase(e).length < 2).map(e => e[0]); // under two log lines, a phase proves nothing
  say(`\nVerdict: ${stalled ? 'the stream STALLED in a phase above' : blind.length ? `NO DATA for ${blind.join(', ')} (${mv.length} [mac video] lines in ${LOG}), so this run does NOT prove the stream kept going` : 'the stream kept going in every phase'}.`);
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `real-pass-${ver}-${stamp}.txt`);
  fs.writeFileSync(file, report.join('\n') + '\n');
  console.log(`\nSaved: ${file}`);
  rl.close();
})();
