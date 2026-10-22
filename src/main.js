const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog } = require('electron');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');

// Disable Chromium's camera capture service — we use ffmpeg/AVFoundation directly.
// Without this, Chromium's media process holds the camera device and blocks AVFoundation.
app.commandLine.appendSwitch('disable-features', 'MediaFoundationVideoCapture,HardwareMediaKeyHandling');

// Prevent broken pipe (EPIPE) from crashing the main process.
// This happens when sox/ffmpeg pipes close unexpectedly during streaming.
process.on('uncaughtException', (err) => {
  if (err.code === 'EPIPE') return; // ignore silently — pipe closed, stream already stopped
  throw err; // rethrow everything else so real errors still surface
});

let mainWindow;
let tray;

// Never let a stream password or stream key reach the Stream Log or a failure
// report: ffmpeg prints its output URL (icecast://source:<pw>@…), and a DJ who
// pastes the log into a chat would leak it.
function maskSecrets(s) {
  return String(s)
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^:\/\s@'"]+:)[^@\s'"]+@/gi, '$1****@')
    // Stop at '|' and ']': a video show's tee output ("[f=flv]rtmp://…/<key>|[f=matroska]/path/show.mkv") must mask
    // the key, not the file name.
    .replace(/(\brtmps?:\/\/[^\s'"|\]]+\/)[^\s\/'"|\]]{6,}/gi, '$1****');
}

// Guard all IPC sends — window may be destroyed on quit. Every Stream Log line also goes to the log file.
function safeSend(sender, channel, data) {
  if (data && typeof data === 'object') {
    if (typeof data.msg === 'string') data = { ...data, msg: maskSecrets(data.msg) };
    if (typeof data.raw === 'string') data = { ...data, raw: maskSecrets(data.raw) };
  }
  if (channel === 'stream-log' && data && data.msg) writeLog(data.type, data.msg, data.tech);
  try {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) sender.send(channel, data);
  } catch (_) {}
}

// ─── Build info (1.5.0) ───────────────────────────────────────────────────────
// src/build-info.json is written by scripts/stamp-build.js (electron-builder's beforePack hook) into every
// packaged build. Without it (npm start) the commit reads "dev".
function buildInfo() {
  let b = {};
  try { b = JSON.parse(fs.readFileSync(path.join(__dirname, 'build-info.json'), 'utf8')); } catch {}
  return { version: app.getVersion(), commit: b.commit || 'dev', date: b.date || null };
}
const OS_NAME = { linux: 'Linux', win32: 'Windows', darwin: 'macOS' }[process.platform] || process.platform;
function buildLine() {
  const b = buildInfo();
  return `Grooveline Broadcaster ${b.version} (${b.commit}${b.date ? ', built ' + b.date.slice(0, 10) : ''}) · ${OS_NAME} ${os.release()} ${process.arch} · Electron ${process.versions.electron}`;
}

// ─── Log file (1.5.0) ─────────────────────────────────────────────────────────
// <userData>/logs/broadcaster.log is this session; broadcaster.1.log … .4.log are the four before it. One line per
// Stream Log entry with an ISO timestamp, secrets masked. "[tech]" marks the raw ffmpeg lines.
const LOG_KEEP = 5, LOG_MAX_BYTES = 5e6;
let logFile = null, logBytes = 0;
function logsDir() { return path.join(app.getPath('userData'), 'logs'); }
function openLogFile() {
  try {
    const dir = logsDir();
    fs.mkdirSync(dir, { recursive: true });
    for (let i = LOG_KEEP - 1; i > 0; i--) {
      const from = path.join(dir, i === 1 ? 'broadcaster.log' : `broadcaster.${i - 1}.log`);
      try { fs.renameSync(from, path.join(dir, `broadcaster.${i}.log`)); } catch {}
    }
    logFile = path.join(dir, 'broadcaster.log');
    logBytes = 0;
  } catch { logFile = null; }
}
function writeLog(type, msg, tech) {
  if (!logFile || logBytes > LOG_MAX_BYTES) return;
  const line = `${new Date().toISOString()} ${String(type || 'info').padEnd(7)}${tech ? ' [tech]' : ''} ${maskSecrets(String(msg)).replace(/\s*\n\s*/g, ' ')}\n`;
  try { fs.appendFileSync(logFile, line); logBytes += line.length; } catch {}
  if (logBytes > LOG_MAX_BYTES) { try { fs.appendFileSync(logFile, `${new Date().toISOString()} warn    Log file full (5 MB): later lines are only in the app.\n`); } catch {} }
}

// ─── Level meter tap (1.5.0) ──────────────────────────────────────────────────
// While live, every ffmpeg gets one extra output: the stream's own audio chain (channel pair + volume) as raw
// 16-bit stereo at 44.1 kHz on stdout (176 KB/s: a 64 KB pipe holds ~0.37 s if main is briefly busy). The meters show exactly what leaves the app, from the same process,
// so the device is never opened twice, and live recording writes the same samples.
// stdout must ALWAYS be drained: a full pipe blocks ffmpeg, time= stops, and the supervisor relaunches in a loop.
const TAP_RATE = 44100, TAP_BLOCK = 1470; // 30 meter updates per second
function meterTapArgs(inputIdx, chain) {
  return ['-map', `${inputIdx}:a?`, '-af', chain, '-c:a', 'pcm_s16le', '-ar', String(TAP_RATE), '-ac', '2', '-f', 's16le', 'pipe:1'];
}
const toDb = v => v > 1e-6 ? 20 * Math.log10(v) : -120;
function attachMeterTap(proc, sender, kind = 'live') {
  if (!proc || !proc.stdout) return;
  let rest = Buffer.alloc(0), n = 0, pL = 0, pR = 0, sL = 0, sR = 0;
  proc.stdout.on('data', chunk => {
    const buf = rest.length ? Buffer.concat([rest, chunk]) : chunk;
    const frames = Math.floor(buf.length / 4);
    // Live recording (1.5.0): the same samples the meters read. buf always starts on a frame boundary.
    if (recWriteStream && recMode === 'pcm' && recFfmpegProc && recFfmpegProc.stdin && !recFfmpegProc.stdin.destroyed) {
      try { recFfmpegProc.stdin.write(Buffer.from(buf.subarray(0, frames * 4))); } catch {}
    }
    for (let i = 0; i < frames; i++) {
      const l = buf.readInt16LE(i * 4) / 32768, r = buf.readInt16LE(i * 4 + 2) / 32768;
      const al = l < 0 ? -l : l, ar = r < 0 ? -r : r;
      if (al > pL) pL = al;
      if (ar > pR) pR = ar;
      sL += l * l; sR += r * r;
      if (++n === TAP_BLOCK) {
        try {
          if (mainWindow && !mainWindow.isDestroyed()) {
            sender.send('meter', { kind, pL: toDb(pL), pR: toDb(pR), rL: toDb(Math.sqrt(sL / n)), rR: toDb(Math.sqrt(sR / n)) });
          }
        } catch {}
        n = 0; pL = pR = sL = sR = 0;
      }
    }
    rest = Buffer.from(buf.subarray(frames * 4));
  });
  proc.stdout.on('error', () => {});
}

// ─── Preview meter on Linux (1.5.0) ───────────────────────────────────────────
// Chromium can't open PipeWire/Pulse monitors ("Monitor of …"), and its device list doesn't always line up with
// ffmpeg's. So on Linux the levels before going live come from ffmpeg capturing exactly the source the stream will
// use (PipeWire lets several apps record one source). It runs at 100 %; the renderer applies the fader. A recording
// made while not live is fed from it too. start-stream stops it first.
let previewMeterProc = null;
function stopPreviewMeter() {
  if (previewMeterProc) { try { previewMeterProc.kill('SIGTERM'); } catch {} previewMeterProc = null; }
}
ipcMain.handle('meter-preview-start', (event, { deviceName, audioChannels, sampleRate }) => {
  stopPreviewMeter();
  if (process.platform !== 'linux' || isStreaming) return { ok: false };
  const parts = String(audioChannels || '0,1').split(',');
  const cL = parseInt(parts[0]) || 0, cR = parseInt(parts[1] !== undefined ? parts[1] : parts[0]) || 1;
  const args = ['-hide_banner', '-loglevel', 'error', '-f', 'pulse', '-ar', String(sampleRate || 48000), '-ac', String(Math.max(2, cL + 1, cR + 1)),
    '-i', pulseSource(deviceName), ...meterTapArgs(0, `pan=stereo|c0=c${cL}|c1=c${cR}`)];
  let p;
  try { p = spawn(findFFmpeg(), args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return { ok: false, error: e.message }; }
  previewMeterProc = p;
  attachMeterTap(p, event.sender, 'preview');
  let err = '';
  p.stderr.on('data', d => { err = (err + d).slice(-400); });
  p.on('error', () => {});
  p.on('close', code => {
    if (previewMeterProc !== p) return;
    previewMeterProc = null;
    if (code) safeSend(event.sender, 'stream-log', { type: 'warn', msg: `Level preview stopped (${err.trim().split('\n').pop() || 'code ' + code})`, tech: true });
  });
  return { ok: true };
});
ipcMain.handle('meter-preview-stop', () => { stopPreviewMeter(); return { ok: true }; });

// Linux (PipeWire/PulseAudio): ffmpeg needs the source NAME. Until 1.5.0 it got a list position ("0", "1"…), which
// PipeWire quietly replaces with the default source, so the picked input was ignored.
function pulseSource(name, fallback) {
  if (name && name !== 'default' && !/^\d+$/.test(name)) return name;
  if (fallback && !/^\d+$/.test(String(fallback))) return String(fallback);
  return 'default';
}
let ffmpegProcess = null;
let isStreaming = false;
let streamStartTime = null;
let configPath = path.join(app.getPath('userData'), 'config.json');

// ─── Default config ───────────────────────────────────────────────────────────
const defaultConfig = {
  profiles: [],
  audioDevice: '',
  videoDevice: '',
  audioOnly: false,
  quality: {
    audioBitrate: '192k',
    videoBitrate: '1000k',
    videoSize: '1280x720',
    fps: 30,
    audioSampleRate: 44100
  },
  volume: 100
};

function loadConfig() {
  try {
    if (fs.existsSync(configPath)) {
      return { ...defaultConfig, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) };
    }
  } catch (e) { console.error('Config load error:', e); }
  return { ...defaultConfig };
}

function saveConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  } catch (e) { console.error('Config save error:', e); }
}

// ─── Find ffmpeg ──────────────────────────────────────────────────────────────
function findFFmpeg() {
  const isWin = process.platform === 'win32';
  const candidates = [
    path.join(process.resourcesPath || '', isWin ? 'ffmpeg.exe' : 'ffmpeg'),
    isWin ? 'ffmpeg.exe' : null,
    'ffmpeg'
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return isWin ? 'ffmpeg.exe' : 'ffmpeg';
}

// ─── Multi-stream: single ffmpeg tee muxer — one capture, all outputs ─────────
// Returns a single args array that feeds all profiles from one input.
// recordingPath: if set, also tee to this file (mp4/aac/wav).
// recordingFormat: 'aac'|'wav'|'mp4'
// The booking's RTMP URL: the credentials API's rtmp_url since 1.6.0, else base + stream key.
function rtmpUrlOf(p) {
  if (p.rtmpUrl) return p.rtmpUrl;
  return p.streamKey ? `${p.rtmpBase || ''}${p.streamKey}` : '';
}

// Stream size, capped at 720p: the server relay re-encodes for Telegram and 1080p pegs the 2-core VPS.
function streamSize(quality) {
  const m = String(quality.videoSize || '').match(/^(\d+)x(\d+)$/);
  return m && +m[1] <= 1280 && +m[2] <= 720 ? `${m[1]}x${m[2]}` : '1280x720';
}

// ── Camera formats (1.6.0) ────────────────────────────────────────────────────
// With no format given, ffmpeg opens a camera raw at its default size. Over USB 2 most webcams do 720p30 only as
// MJPEG, so the stream was choppy or 640x480 scaled up. Ask each camera once what it offers: MJPEG at the stream
// size first, then raw at that size, then the largest size below it. facetimehd is raw-only (yuyv422 1280x720).
const camFormatCache = new Map();
const sizeArea = sz => sz.split('x').reduce((a, b) => a * b, 1);
function pickCamFormat(formats, size) {
  const mj = formats.filter(f => f.mjpeg), raw = formats.filter(f => !f.mjpeg);
  const [W, H] = size.split('x').map(Number);
  const all = list => list.flatMap(f => f.sizes.map(sz => ({ f, sz, w: +sz.split('x')[0], h: +sz.split('x')[1] })));
  const exact = list => list.find(f => f.sizes.includes(size) || f.range);
  // The smallest size that covers the stream (scaled down, never up), else the largest below it.
  const cover = list => all(list).filter(x => x.w >= W && x.h >= H).sort((a, b) => sizeArea(a.sz) - sizeArea(b.sz))[0];
  const below = list => all(list).filter(x => sizeArea(x.sz) <= sizeArea(size)).sort((a, b) => sizeArea(b.sz) - sizeArea(a.sz))[0];
  const f = exact(mj) || exact(raw);
  if (f) return { f, sz: size };
  const b = cover(mj) || cover(raw) || below(mj) || below(raw);
  return b ? { f: b.f, sz: b.sz } : null;
}
function v4l2InputArgs(dev, size) {
  const key = `v4l2|${dev}|${size}`;
  if (camFormatCache.has(key)) return camFormatCache.get(key);
  let out = '';
  try { out = spawnSync(findFFmpeg(), ['-hide_banner', '-f', 'v4l2', '-list_formats', 'all', '-i', dev], { encoding: 'utf8', timeout: 4000 }).stderr || ''; } catch {}
  // "[video4linux2,v4l2 @ 0x…] Compressed:       mjpeg :          Motion-JPEG : 640x480 1280x720"
  const formats = [];
  for (const line of out.split('\n')) {
    const m = line.match(/\]\s*(Compressed|Raw)\s*:\s*(\S+)\s*:[^:]*:\s*(.*)$/);
    if (m && !/emulated/i.test(line)) formats.push({ mjpeg: /mjpeg/i.test(m[2]), name: m[2], sizes: m[3].match(/\d+x\d+/g) || [], range: m[3].includes('{') });
  }
  const pick = pickCamFormat(formats, size);
  const r = pick ? { args: ['-input_format', pick.f.mjpeg ? 'mjpeg' : pick.f.name, '-video_size', pick.sz], label: `${pick.f.mjpeg ? 'MJPEG' : pick.f.name} ${pick.sz}` }
    : { args: [], label: 'camera default format' };
  camFormatCache.set(key, r);
  return r;
}
function dshowVideoArgs(name, size) {
  const key = `dshow|${name}|${size}`;
  if (camFormatCache.has(key)) return camFormatCache.get(key);
  let out = '';
  try { out = spawnSync(findFFmpeg(), ['-hide_banner', '-f', 'dshow', '-list_options', 'true', '-i', `video=${name}`], { encoding: 'utf8', timeout: 6000 }).stderr || ''; } catch {}
  // "[dshow @ …]   vcodec=mjpeg  min s=1280x720 fps=5 max s=1280x720 fps=30"
  const formats = [];
  for (const line of out.split('\n')) {
    const m = line.match(/(vcodec|pixel_format)=(\S+)\s+min s=(\d+x\d+) fps=[\d.]+\s+max s=(\d+x\d+) fps=([\d.]+)/);
    if (m && parseFloat(m[5]) >= 25) {
      const known = formats.find(f => f.kind === m[1] && f.name === m[2]);
      if (known) known.sizes.push(m[4]); else formats.push({ kind: m[1], name: m[2], mjpeg: m[1] === 'vcodec' && m[2] === 'mjpeg', sizes: [m[4]] });
    }
  }
  const pick = pickCamFormat(formats.filter(f => f.mjpeg || f.kind === 'pixel_format'), size);
  const r = pick ? { args: [...(pick.f.mjpeg ? ['-vcodec', 'mjpeg'] : ['-pixel_format', pick.f.name]), '-video_size', pick.sz], label: `${pick.f.mjpeg ? 'MJPEG' : pick.f.name} ${pick.sz}` }
    : { args: [], label: 'camera default format' };
  camFormatCache.set(key, r);
  return r;
}

// A file path inside a tee output spec: the tee muxer unescapes '\' and treats ' | [ ] specially.
function teePath(p) { return String(p).replace(/\\/g, '/').replace(/(['|\[\]])/g, '\\$1'); }

function buildTeeArgs(profiles, quality, audioDevice, videoDevice, audioOnly, volume, audioChannels, audioDeviceName, videoDeviceName, recordingPath, recordingFormat, onCamFormat) {
  const platform = process.platform;
  const args = [];
  const size = streamSize(quality);
  const vol = Math.max(0, Math.min(100, volume ?? 100)) / 100;
  const parts = (audioChannels || '0,1').split(',');
  const cL = parseInt(parts[0]) || 0;
  const cR = parseInt(parts[1] !== undefined ? parts[1] : parts[0]) || 1;
  const nativeSampleRate = quality.nativeSampleRate || 44100;
  // Number of channels to request from the capture device — must cover the selected pair
  const capChannels = Math.max(2, cL + 1, cR + 1);

  // ── Single input ──
  if (audioOnly) {
    if (platform === 'darwin') {
    } else if (platform === 'win32') {
      args.push('-f', 'dshow', '-audio_buffer_size', '50',
        '-i', `audio=${audioDeviceName || 'default'}`);
    } else {
      args.push('-f', 'pulse', '-ar', String(nativeSampleRate), '-ac', String(capChannels),
        '-i', pulseSource(audioDeviceName, audioDevice));
    }
  } else {
    if (platform === 'darwin') {
      const avVideo = String(videoDevice || '0');
      const avAudio = /^\d+$/.test(String(audioDevice)) ? audioDevice : '0';
      args.push(
        '-f', 'avfoundation',
        '-framerate', String(quality.fps || 30),
        '-thread_queue_size', '512',
        '-probesize', '32',
        '-analyzeduration', '0',
        '-i', `${avVideo}:${avAudio}`);
    } else if (platform === 'win32') {
      const camName = videoDeviceName || videoDevice || 'default';
      const cf = dshowVideoArgs(camName, size);
      if (onCamFormat) onCamFormat(cf.label);
      args.push('-f', 'dshow', ...cf.args, '-framerate', String(quality.fps || 30),
        '-audio_buffer_size', '50',
        '-i', `video=${camName}:audio=${audioDeviceName || 'default'}`);
    } else {
      // videoDevice is a /dev/videoN path from listV4l2Devices(); anything else (old configs saved
      // '0') falls back to the first camera, so ffmpeg never gets a bare index it can't open.
      const v4l = /^\/dev\/video\d+$/.test(String(videoDevice || '')) ? String(videoDevice)
        : ((listV4l2Devices()[0] || {}).path || '/dev/video0');
      const cf = v4l2InputArgs(v4l, size);
      if (onCamFormat) onCamFormat(cf.label);
      args.push('-f', 'v4l2', ...cf.args, '-framerate', String(quality.fps || 30), '-i', v4l);
      args.push('-f', 'pulse', '-ar', String(nativeSampleRate), '-ac', String(capChannels),
        '-i', pulseSource(audioDeviceName, audioDevice));
    }
  }

  // ── Shared audio filter — reset timestamps to 0 (capture devices start at epoch offset) ──
  const audioChain = `asetpts=PTS-STARTPTS,pan=stereo|c0=c${cL}|c1=c${cR},volume=${vol}`;
  // Linux video has the camera as input 0 and PulseAudio as input 1; every other layout has audio on input 0.
  const tap = meterTapArgs(!audioOnly && platform !== 'win32' && platform !== 'darwin' ? 1 : 0, audioChain);
  args.push('-af', audioChain);

  // ── Shared video encode (reused across all outputs via tee) ──
  if (!audioOnly) {
    const [w, h] = size.split('x');
    args.push(
      '-vf', `setpts=PTS-STARTPTS,format=yuv420p,scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`,
      '-vcodec', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
      '-threads', '0',
      '-crf', '28',
      '-maxrate', quality.videoBitrate || '1000k',
      '-bufsize', String(parseInt(quality.videoBitrate || '1000k') * 2) + 'k',
      '-r', String(quality.fps || 30),
      '-g', String((quality.fps || 30) * 2), '-keyint_min', String(quality.fps || 30),
    );
    // Encode audio as AAC for tee muxer (Icecast output re-encodes with map_0:a below)
    args.push('-acodec', 'aac', '-b:a', quality.audioBitrate || '320k', '-ar', '44100', '-ac', '2');
  } else {
    // Audio-only — encode once as AAC, Icecast outputs will re-encode to vorbis per-output
    args.push('-acodec', 'aac', '-b:a', quality.audioBitrate || '320k', '-ar', '44100', '-ac', '2');
  }

  // ── Tee outputs ──
  const teeOutputs = [];

  profiles.forEach(profile => {
    const isIcecast = profile.type === 'icecast' || profile.type === 'shoutcast';
    const server = profile.server || 'localhost';
    const serverWithPort = server.includes(':') ? server : `${server}:8000`;
    const iceUser = profile.username || 'source';

    if (isIcecast) {
      // Icecast needs Ogg/Vorbis — use separate output with re-encode
      const url = `icecast://${iceUser}:${profile.password || 'hackme'}@${serverWithPort}${profile.mount || '/stream'}`;
      // Separate -map + codec flags before this output
      teeOutputs.push({ icecast: true, url, password: profile.password, server: serverWithPort, mount: profile.mount, iceUser });
    } else {
      teeOutputs.push({ icecast: false, url: rtmpUrlOf(profile), audioOnly });
    }
  });

  // If only one non-icecast output and no icecast, use simple output (no tee complexity)
  const icecastOutputs = teeOutputs.filter(o => o.icecast);
  const otherOutputs = teeOutputs.filter(o => !o.icecast);

  if (icecastOutputs.length === 0 && otherOutputs.length === 1) {
    const o = otherOutputs[0];
    if (recordingPath && !audioOnly) {
      // Video show recorded on this computer (1.6.0): one encode, two outputs. The file branch may fail without
      // touching the stream. Through tee, FLV needs the encoders' global headers (no AVC/AAC sequence header
      // otherwise); Matroska keeps them, survives a crash, and is remuxed to MP4 when the show ends.
      args.push('-map', '0:v', '-map', platform === 'win32' ? '0:a' : '1:a', '-flags:v', '+global_header', '-flags:a', '+global_header',
        '-f', 'tee', `[f=flv:flvflags=no_duration_filesize]${o.url}|[f=matroska:onfail=ignore]${teePath(recordingPath)}`);
    } else {
      args.push('-f', 'flv', '-flvflags', 'no_duration_filesize', o.url);
    }
    args.push(...tap);
    return args;
  }

  // Multiple outputs — use multiple -map/-codec/-f output blocks (safer than tee for mixed formats)
  // First: RTMP/recording outputs (copy encoded video+audio)
  otherOutputs.forEach(o => {
    if (o.recording) {
      const fmt = o.format === 'wav' ? 'wav' : 'mp4';
      if (o.format === 'wav') {
        args.push('-map', '0:a', '-c:a', 'pcm_s16le', '-ar', '44100', '-ac', '2', '-f', 'wav', o.path);
      } else {
        args.push('-map', '0:a', ...(audioOnly ? [] : ['-map', '0:v', '-c:v', 'copy']),
          '-c:a', 'copy', '-f', fmt, o.path);
      }
    } else {
      if (audioOnly) {
        args.push('-map', '0:a', '-c:a', 'copy', '-f', 'flv', o.url);
      } else {
        args.push('-map', '0:v', '-map', '0:a', '-c', 'copy', '-f', 'flv', o.url);
      }
    }
  });

  // Icecast outputs — re-encode audio to vorbis for each
  icecastOutputs.forEach(o => {
    const url = `icecast://${o.iceUser}:${o.password || 'hackme'}@${o.server}${o.mount || '/stream'}`;
    args.push('-map', '0:a', '-c:a', 'libvorbis', '-q:a', '6', '-ar', '44100', '-ac', '2',
      '-f', 'ogg', '-content_type', 'audio/ogg', url);
  });

  args.push(...tap);
  return args;
}

// ─── Window ───────────────────────────────────────────────────────────────────
async function requestMediaPermissions() {
  if (process.platform !== 'darwin') return;
  const { systemPreferences } = require('electron');
  try {
    // Don't await — fire and forget so we never block or throw before window is ready
    const micStatus = systemPreferences.getMediaAccessStatus('microphone');
    if (micStatus !== 'granted') {
      systemPreferences.askForMediaAccess('microphone')
        .then(g => console.log('[permissions] microphone:', g ? 'granted' : 'denied'))
        .catch(e => console.warn('[permissions] mic error:', e.message));
    }
    const camStatus = systemPreferences.getMediaAccessStatus('camera');
    if (camStatus !== 'granted') {
      systemPreferences.askForMediaAccess('camera')
        .catch(e => console.warn('[permissions] cam error:', e.message));
    }
  } catch(e) {
    console.warn('[permissions] error:', e.message);
    // Never rethrow — a permissions error must never crash the app
  }
}

// Window controls per OS (1.5.0): macOS keeps its real traffic lights over our header, Windows gets its native
// caption buttons drawn on the dark header, Linux uses the desktop's own frame (Hyprland draws none). Until 1.4.0
// every OS got a frameless window with Mac-style dots.
function windowChrome() {
  if (process.platform === 'darwin') return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 19 } };
  if (process.platform === 'win32') return { titleBarStyle: 'hidden', titleBarOverlay: { color: '#080810', symbolColor: '#c8d0f0', height: 52 } };
  return { frame: true, autoHideMenuBar: true };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 860,
    height: 720,
    minWidth: 760,
    minHeight: 640,
    resizable: true,
    title: `Grooveline Broadcaster ${app.getVersion()}`,
    ...windowChrome(),
    backgroundColor: '#050508',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: process.platform === 'darwin'
      ? path.join(__dirname, '..', 'assets', 'icon.icns')
      : path.join(__dirname, '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png')
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Grant microphone + camera permissions automatically (required in packaged .app). 'fullscreen' lets the camera
  // preview go full screen on a double-click (1.5.0): without it Electron quietly refuses requestFullscreen().
  const allowedPermissions = ['media', 'microphone', 'camera', 'audioCapture', 'videoCapture', 'fullscreen'];
  mainWindow.webContents.session.setPermissionRequestHandler((wc, permission, callback) => {
    callback(allowedPermissions.includes(permission));
  });
  mainWindow.webContents.session.setPermissionCheckHandler((wc, permission) => allowedPermissions.includes(permission));

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  let devicesReleased = false;
  mainWindow.on('close', (e) => {
    if (isStreaming) {
      e.preventDefault();
      mainWindow.webContents.send('confirm-close');
      return;
    }
    // Stop the camera preview before the window (and Chromium's capture process) goes.
    if (devicesReleased) return;
    e.preventDefault();
    releaseDevices().then(() => {
      devicesReleased = true;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
      if (quitRequested) app.quit();
    });
  });
}

// Close the camera cleanly before the app exits. Killing Chromium's capture process mid-stream (closing the app with
// the preview open) made facetimehd log an IO timeout and ~2,800 DMA faults (22 Oct 2026). A stopped track or a
// SIGTERM'd ffmpeg stops the stream first and logged nothing.
let quitRequested = false;

// Linux: the pids in our process tree (Chromium's helpers, ffmpeg) that have a /dev/videoN open.
function videoHolders() {
  const tree = new Set([process.pid]), procs = [];
  try {
    for (const n of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(n)) continue;
      try { const st = fs.readFileSync(`/proc/${n}/stat`, 'utf8'); procs.push([+n, +st.slice(st.lastIndexOf(')') + 2).split(' ')[1]]); } catch {}
    }
  } catch { return []; }
  for (let grew = true; grew;) { grew = false; for (const [pid, ppid] of procs) if (!tree.has(pid) && tree.has(ppid)) { tree.add(pid); grew = true; } }
  return [...tree].filter(pid => {
    try { return fs.readdirSync(`/proc/${pid}/fd`).some(fd => { try { return /^\/dev\/video\d+$/.test(fs.readlinkSync(`/proc/${pid}/fd/${fd}`)); } catch { return false; } }); }
    catch { return false; }
  });
}

// Asks the page to stop its camera/mic tracks, then waits until nothing of ours holds a camera (Linux, max 2.5 s;
// elsewhere a short pause).
function releaseDevices() {
  return new Promise(resolve => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      ipcMain.removeAllListeners('devices-released');
      if (process.platform !== 'linux') return setTimeout(resolve, 300);
      const t0 = Date.now();
      const poll = () => (!videoHolders().length || Date.now() - t0 > 2500) ? resolve() : setTimeout(poll, 100);
      poll();
    };
    const wc = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
    if (!wc) return settle();
    ipcMain.once('devices-released', settle);
    setTimeout(settle, 1500);
    wc.send('release-devices');
  });
}

function createTray() {
  // Use the app icon — on macOS, a 22x22 template image works best for the menu bar
  let img;
  try {
    const iconPath = process.platform === 'darwin'
      ? path.join(__dirname, '..', 'assets', 'icon.png')
      : path.join(__dirname, '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
    img = nativeImage.createFromPath(iconPath);
    if (process.platform === 'darwin') {
      // Resize to 22x22 for macOS menu bar, mark as template so macOS handles dark/light mode
      img = img.resize({ width: 22, height: 22 });
      img.setTemplateImage(true);
    }
  } catch (_) {
    img = nativeImage.createEmpty();
  }
  tray = new Tray(img);
  tray.setToolTip('Grooveline Broadcaster');
  const menu = Menu.buildFromTemplate([
    { label: 'Show', click: () => mainWindow?.show() },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.quit(); } }
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => mainWindow?.show());
}

// ─── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  openLogFile();
  writeLog('info', buildLine());
  // Windows/Linux: no menu bar (Electron's default File/Edit/View showed up under a native frame). macOS keeps the
  // default app menu: it carries About, Quit and the Edit shortcuts (copy/paste).
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  else {
    const b = buildInfo();
    app.setAboutPanelOptions({ applicationName: 'Grooveline Broadcaster', applicationVersion: b.version, version: b.commit,
      copyright: 'MIT licence · grooveline.org', website: 'https://grooveline.org' });
  }
  // Create window immediately — never await anything before this
  createWindow();
  try { createTray(); } catch(e) {}
  // Request permissions after window exists (fire and forget)
  requestMediaPermissions();
});

app.on('before-quit', () => {
  quitRequested = true;
  // Kill all child processes before window is destroyed — prevents "Object has been destroyed" crash
  pcmProcesses.forEach(p => { try { p.kill('SIGKILL'); } catch {} });
  pcmProcesses = [];
  stopPreviewMeter();
  if (recordingProcess) { try { recordingProcess.kill('SIGKILL'); } catch {} recordingProcess = null; }
  if (tray) { try { tray.destroy(); } catch {} tray = null; }
});

app.on('window-all-closed', () => {
  stopPreviewMeter();
  stopAllStreams();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ─── Streaming state ──────────────────────────────────────────────────────────
const activeProcesses = [];

function stopAllStreams() {
  endLiveSession();
  // ffmpeg finishes its files on 'q' (a video show's recording needs its trailer); a signal is the fallback.
  activeProcesses.forEach(p => {
    if (p._qStop && p.stdin && !p.stdin.destroyed) {
      try { p.stdin.write('q'); } catch {}
      setTimeout(() => { if (p.exitCode === null && p.signalCode === null) { try { p.kill('SIGTERM'); } catch {} } }, 3000);
    } else { try { p.kill('SIGTERM'); } catch {} }
  });
  activeProcesses.length = 0;
  isStreaming = false;
  videoFfmpegProc = null;
  videoSoxProc = null;
}

// ─── Live supervisor (1.2.0, 20 Oct 2026) ─────────────────────────────────────
// Up to 1.1.x a dropped connection ended the show: ffmpeg exited, the app went
// offline and nothing retried — the same failure class as Traktor, which never
// reconnects. Now GO LIVE opens a session that lasts until STOP. When the
// pipeline exits, or stalls (a dead network path often leaves ffmpeg blocked on
// a write instead of exiting), everything is torn down and relaunched with
// backoff for as long as the DJ stays live.
//
// Icecast answers a reconnect with 403 "Mountpoint in use" while the old, dead
// connection still holds the mount — until the server's source-timeout (600 s
// on Grooveline) — so 403 means "keep trying", every 15 s. A 401 (password
// refused — credentials expire at slot end) or an audio input that keeps
// failing stops after 3 tries: retrying can't fix those.
let liveSession = null;
const RETRY_DELAYS_S = [2, 4, 8, 15, 30];
const STALL_MS = 15000;        // progress lines stopped → the path is dead
const FIRST_DATA_MS = 30000;   // a launch that never starts sending
const HEALTHY_MS = 20000;      // sending this long → reset the failure counters
const AUTH_GRACE_MS = 120000;  // 401s are expected while a new mount syncs (1-min cron)
// Video (1.6.0): every relaunch reopens the camera, and facetimehd wedged on 21 Oct after a reopen every few seconds.
const VIDEO_RETRY_DELAYS_S = [5, 10, 20, 30];
// MediaMTX accepts the RTMP connection, asks Grooveline about the stream key, and closes it about 2 s later when the
// answer is no. ffmpeg only sees "Connection reset by peer", so a reset this soon after launch counts as a refusal.
const RTMP_REFUSED_MS = 12000;
const RTMP_CONFIRM_MS = 5000;  // sending this long on RTMP = past the key check → ON AIR / "Connected"
// What a refusal looks like: the server cut off a stream that was already sending. Connect errors (DNS, unreachable,
// refused, timed out) are the network, and so is any drop once the show has been on air: those keep retrying.
const RTMP_CUT_LINE = /Connection reset|Broken pipe|End of file|Error writing trailer|Slave muxer/i;
const STAGE_TEXT = {
  refused: "Grooveline's video server refused the stream: the slot isn't open for streaming (from 15 minutes before it starts until it ends), or the stream key is out of date",
  auth: 'the server refused the password (a new mount can take up to a minute to be ready)',
  mount_in_use: 'the server is still holding your previous connection — it lets go by itself, keep the app open',
  device: 'the audio input stopped or is unavailable',
  camera: 'the camera stopped or is unavailable',
  encoder: 'the encoder failed',
  network: 'the network connection dropped',
  stalled: 'nothing has left your computer for 15 s',
};

// A 403 is a wait, not a failure: Icecast keeps a dead connection until the
// sync agent's stale-source killer (60 s, /check-* only for now) or its own
// source-timeout (600 s) frees the mount.
function stageText(s, stage) {
  if (stage !== 'mount_in_use') return STAGE_TEXT[stage];
  const p = s && s.opts && s.opts.profiles.find(x => x.enabled && x.type === 'icecast');
  const isCheck = p && (p.mount || '').startsWith('/check-');
  return STAGE_TEXT.mount_in_use + (isCheck ? ' (about a minute)' : ' (up to 10 minutes)');
}

// A device error that names the camera (Linux v4l2, Windows dshow). Until 1.4.0 these counted as the audio input,
// so a missing camera ended with "the audio input failed 3 times".
const CAMERA_LINE = /\/dev\/video\d|video4linux|v4l2|video device|Could not set video options/i;

function classifyLine(line) {
  // Only the server's own answer counts. 1.5.1 read libx264's exit summary "kb/s:403.68" as a 403 and told a DJ the
  // server was holding an old connection (22 Oct).
  if (/\bkb\/s:|Qavg|frame I:|frame P:/.test(line)) return null;
  if (/(Server returned|HTTP error) 401\b|\b401 Unauthorized/i.test(line)) return 'auth';
  if (/(Server returned|HTTP error) 403\b|\b403 Forbidden/i.test(line)) return 'mount_in_use';
  if (/Error opening output|Connection refused|timed out|Network is unreachable|No route to host|resolve|not known|nodename|Connection reset|Broken pipe|End of file|Error writing trailer/i.test(line)) return 'network';
  if (/Error opening input|sox FAIL|can't open input|Could not (find|open)|No such (file|device)|Device or resource busy|I\/O error|Unknown input format/i.test(line)) return CAMERA_LINE.test(line) ? 'camera' : 'device';
  if (/Unknown encoder|Error initializing output stream|Error while opening encoder/i.test(line)) return 'encoder';
  return null;
}

// Fire-and-forget failure report → POST /setup/report (needs the DJ's account
// login; skipped without it). Tells us why a slot stayed empty.
function reportSetup(event, fields) {
  try {
    const token = loadConfig()._acctToken;
    if (!token) return;
    // A sound check is not a set — tag it so the reports never count it as one.
    const tag = liveSession && liveSession.soundCheck ? 'sound check: ' : '';
    const detail = fields && fields.detail ? maskSecrets(fields.detail) : (tag ? '-' : '');
    apiRequest('POST', '/setup/report', {
      source: 'app', event, app_version: app.getVersion(),
      os: `${process.platform} ${os.release()} ${process.arch}`.slice(0, 60),
      ...fields,
      detail: detail ? (tag + detail).slice(0, 500) : null,
    }, token).catch(() => {});
  } catch {}
}

function tagProc(proc) { if (liveSession) proc._gen = liveSession.gen; return proc; }

function isVideoSession(s) { return !!(s && !s.opts.audioOnly && s.opts.profiles.some(p => p.type === 'mediamtx')); }

// True once this launch's sending counts: at once on the radio, after RTMP_CONFIRM_MS on video (see RTMP_REFUSED_MS).
// Until then the renderer gets no stream-stats, so it keeps saying CONNECTING instead of ON AIR.
function progressConfirmed(s) {
  if (!s) return true;
  return !!s.firstProgressAt && (!isVideoSession(s) || Date.now() - s.firstProgressAt >= RTMP_CONFIRM_MS);
}

// Called from every pipeline stderr handler.
function superviseLine(proc, line) {
  const s = liveSession;
  if (!s || proc._gen !== s.gen) return;
  if (line.includes('size=') || line.includes('time=')) {
    const t = (line.match(/time=\s*(\S+)/) || [])[1];
    if (t && t === s.lastTime) return; // a repeated report is not progress
    s.lastTime = t;
    s.lastProgress = Date.now();
    if (!s.firstProgressAt) s.firstProgressAt = s.lastProgress;
    const first = !s.confirmed && progressConfirmed(s);
    if (first) { s.confirmed = true; s.everConfirmed = true; }
    if (first && s.uiReconnecting) {
      s.uiReconnecting = false;
      const secs = s.outageStart ? Math.round((Date.now() - s.outageStart) / 1000) : null;
      safeSend(s.sender, 'stream-reconnected', { secs });
      safeSend(s.sender, 'stream-log', { type: 'success', msg: secs !== null ? `✓ Back on air after ${secs}s` : '✓ Connected' });
      if (s.outageStart) {
        reportSetup('app_reconnected', { stage: s.outageStage, detail: `back after ${secs}s, ${s.attempt} attempt(s)` });
        s.outageStart = null;
      }
    }
    return;
  }
  const stage = classifyLine(line);
  // ffmpeg follows a camera error with generic "Error opening input" lines; keep the camera as the cause.
  if (stage && !(s.stage === 'camera' && stage === 'device')) { s.stage = stage; s.lastLine = line; }
}

// Video slot without a working camera (none found, or it failed): stream to the booking's radio mount instead, so
// the DJ is still on air (Zé, 21 Oct 2026). Changes the session's opts, so every relaunch stays on the radio.
function fallBackToRadio(sender, opts, why) {
  const fb = opts.fallbackProfile;
  if (!fb) return false;
  opts.profiles = [fb]; opts.audioOnly = true; opts.fallbackProfile = null;
  safeSend(sender, 'stream-log', { type: 'warn', msg: `⚠ ${why}: streaming audio to the radio instead (${fb.mount || 'your mount'}). Your video is not on air.` });
  safeSend(sender, 'stream-fallback', { why });
  reportSetup('app_error', { stage: 'camera', detail: `${why}, fell back to the radio` });
  return true;
}

// Called from every pipeline 'close' handler. Returns true if the supervisor
// took over (the caller must then not send 'stream-stopped').
function pipelineExited(proc, code) {
  const s = liveSession;
  if (!s || !s.supervise) return false;
  if (proc._gen !== s.gen || s.tearingDown) return true; // one we killed on purpose
  scheduleRestart(`exited (code ${code})`);
  return true;
}

function scheduleRestart(why) {
  const s = liveSession;
  if (!s || s.restartTimer) return;
  s.tearingDown = true;
  if (s.watchdog) { clearInterval(s.watchdog); s.watchdog = null; }
  activeProcesses.splice(0).forEach(p => { try { p.kill('SIGTERM'); } catch {} });
  videoFfmpegProc = null; videoSoxProc = null;

  let stage = s.stage || (s.lastProgress ? 'network' : 'stalled');
  if (stage === 'network' && isVideoSession(s) && !s.everConfirmed && s.firstProgressAt && Date.now() - s.launchedAt < RTMP_REFUSED_MS
    && RTMP_CUT_LINE.test(s.lastLine || '')) stage = 'refused';
  const toRadio = stage === 'camera' && fallBackToRadio(s.sender, s.opts, 'The camera failed');
  s.sameStageFails = toRadio ? 0 : stage === s.prevStage ? s.sameStageFails + 1 : 1;
  s.prevStage = toRadio ? null : stage;
  // A brand-new mount (sound check, a booking made just now) reaches Icecast via
  // the sync agent's 1-minute cron, so 401 is expected at first: keep trying for
  // AUTH_GRACE_MS from GO LIVE before calling the password wrong.
  const inAuthGrace = stage === 'auth' && Date.now() - s.sessionStart < AUTH_GRACE_MS;
  if (['auth', 'device', 'camera', 'encoder', 'refused'].includes(stage) && s.sameStageFails >= 3 && !inAuthGrace) return giveUp(stage);

  if (!s.everLive && !s.reportedError) {
    s.reportedError = true;
    reportSetup('app_error', { stage, detail: s.lastLine || why });
  }
  if (!s.outageStart && s.everLive) {
    s.outageStart = Date.now(); s.outageStage = stage;
    reportSetup('app_reconnecting', { stage, detail: s.lastLine || why });
  }
  s.attempt++;
  s.uiReconnecting = true;
  // While a new mount syncs, retry every 5 s: backing off to 30 s left a DJ
  // waiting up to half a minute after the mount was already there.
  const delays = isVideoSession(s) ? VIDEO_RETRY_DELAYS_S : RETRY_DELAYS_S;
  const delay = toRadio ? 2
    : stage === 'mount_in_use' ? 15
    : inAuthGrace ? 5
    : delays[Math.min(s.attempt - 1, delays.length - 1)];
  safeSend(s.sender, 'stream-reconnecting', { attempt: s.attempt, delay, stage, message: stageText(s, stage) || why });
  safeSend(s.sender, 'stream-log', { type: 'warn', msg: `⟳ ${stageText(s, stage) || why} — retry ${s.attempt} in ${delay}s${s.lastLine ? ` (${s.lastLine.trim().slice(0, 160)})` : ''}` });
  s.restartTimer = setTimeout(() => {
    s.restartTimer = null;
    if (liveSession !== s) return;
    relaunch();
  }, delay * 1000);
}

function giveUp(stage) {
  const s = liveSession;
  const why = stage === 'auth'
    ? 'Stopped: the server kept refusing the password for 2 minutes. Check the password and mount point — booking credentials also expire when your slot ends.'
    : stage === 'device'
    ? 'Stopped: the audio input failed 3 times. Check the device in Sources and press GO LIVE again.'
    : stage === 'camera'
    ? 'Stopped: the camera failed 3 times. Check it is plugged in and not open in another app, then press GO LIVE again.'
    : stage === 'refused'
    ? "Stopped: Grooveline's video server refused the stream 3 times. Your slot opens for streaming 15 minutes before it starts and closes when it ends. Press ↻ on your slot to reload its details, then GO LIVE again."
    : 'Stopped: the encoder failed 3 times. Copy the Stream Log and send it to us.';
  reportSetup('app_gave_up', { stage, detail: s.lastLine || why });
  safeSend(s.sender, 'stream-log', { type: 'error', msg: why });
  const sender = s.sender;
  endLiveSession();
  finishShowRecording(s);
  isStreaming = false;
  safeSend(sender, 'stream-stopped', { reason: why, stage });
}

// Server-side truth. ffmpeg's own progress can't see a dead network path for
// minutes: kernel socket buffers swallow quiet audio (the 20 Oct e2e had Icecast
// drop the source after 600 s while the app still said LIVE). So while live,
// ask the Icecast server itself — the same status-json the site players read —
// whether our mount has a publisher. Unreachable 3× in a row (~15 s), or no
// stream on our mount for 10 s → the path is dead → relaunch.
function checkServerHealth(s) {
  const p = s.opts.profiles.find(x => x.enabled && x.type === 'icecast');
  if (!p || s.healthOff || s.healthBusy) return;
  const server = p.server || 'localhost';
  const hostPort = server.includes(':') ? server : `${server}:8000`;
  const mount = p.mount || '/stream';
  const gen = s.gen;
  const stale = () => liveSession !== s || s.tearingDown || s.gen !== gen;
  const failed = (why) => {
    s.healthBusy = false;
    if (stale()) return;
    s.healthFails = (s.healthFails || 0) + 1;
    if (s.healthFails >= 3) { s.stage = 'network'; s.lastLine = `server unreachable (${why})`; scheduleRestart('server unreachable'); }
  };
  s.healthBusy = true;
  const http = require('http');
  const req = http.get(`http://${hostPort}/status-json.xsl`, { timeout: 4000 }, res => {
    if (res.statusCode === 404) { s.healthOff = true; s.healthBusy = false; res.resume(); return; } // not an Icecast with status-json
    let body = '';
    res.setEncoding('utf8');
    res.on('data', d => { body += d; if (body.length > 2e6) req.destroy(new Error('too large')); });
    res.on('end', () => {
      s.healthBusy = false;
      if (stale()) return;
      s.healthFails = 0;
      let src;
      try { src = [].concat(JSON.parse(body).icestats.source || []).find(x => (x.listenurl || '').endsWith(mount)); }
      catch { return; } // Icecast 2.4 sometimes emits broken JSON — unknown, not dead
      if (src && src.stream_start) { s.missingSince = 0; s.seenOnServer = true; return; }
      // Only a mount we have seen listed can go missing: other Icecast servers
      // may hide mounts (<hidden>1</hidden>), which must not cause relaunches.
      if (!s.seenOnServer) return;
      if (!s.missingSince) { s.missingSince = Date.now(); return; }
      if (Date.now() - s.missingSince > 10000) {
        s.stage = 'network'; s.lastLine = `the server has no stream on ${mount}`;
        scheduleRestart('server has no stream');
      }
    });
    res.on('error', e => failed(e.message));
  });
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.on('error', e => failed(e.message));
}

function relaunch() {
  const s = liveSession;
  s.gen++; s.tearingDown = false; s.stage = null; s.lastLine = '';
  s.lastProgress = 0; s.lastTime = null; s.launchedAt = Date.now(); s.firstProgressAt = 0; s.confirmed = false;
  s.healthFails = 0; s.missingSince = 0; s.healthBusy = false; s.lastHealth = 0;
  let r;
  try { r = launchPipeline(s.event, s.opts); } catch (e) { r = { ok: false, error: e.message }; }
  if (!r.ok) { s.stage = r.stage || s.stage; s.lastLine = r.error || s.lastLine; scheduleRestart(r.error || 'launch failed'); return; }
  startWatchdog();
}

function startWatchdog() {
  const s = liveSession;
  if (!s || !s.supervise) return;
  if (s.watchdog) clearInterval(s.watchdog);
  s.watchdog = setInterval(() => {
    if (liveSession !== s || s.tearingDown) return;
    const now = Date.now();
    if (!s.lastProgress) {
      if (now - s.launchedAt > FIRST_DATA_MS) { s.stage = s.stage || 'stalled'; scheduleRestart('no audio left after 30 s'); }
      return;
    }
    if (now - s.lastProgress > STALL_MS) { s.stage = s.stage || 'stalled'; scheduleRestart('stalled'); return; }
    if (now - s.launchedAt > 10000 && now - (s.lastHealth || 0) >= 5000) { s.lastHealth = now; checkServerHealth(s); }
    if (now - s.launchedAt > HEALTHY_MS && s.attempt) { s.attempt = 0; s.sameStageFails = 0; s.prevStage = null; }
    if (now - s.launchedAt > HEALTHY_MS && !s.everLive) { s.everLive = true; reportSetup('app_live', { detail: s.opts.audioOnly ? 'audio' : 'audio+video' }); }
  }, 2000);
}

function endLiveSession() {
  const s = liveSession;
  if (!s) return;
  if (s.watchdog) clearInterval(s.watchdog);
  if (s.restartTimer) clearTimeout(s.restartTimer);
  liveSession = null;
}

// ─── Video show recorded on this computer (1.6.0) ─────────────────────────────
// Every launch of a video show writes one Matroska part next to the stream (tee, no second encode). STOP or a
// give-up joins the parts into one MP4. Parts under 6 s are refusals or false starts and are dropped. A quit while
// live leaves the .mkv parts in the folder: they play as they are.
function nextShowPart(opts) {
  const rec = liveSession && liveSession.showRec;
  if (!rec || opts.audioOnly) return null;
  try { fs.mkdirSync(rec.folder, { recursive: true }); } catch {}
  const p = path.join(rec.folder, `${rec.base}-part${rec.parts.length + 1}.mkv`);
  rec.parts.push(p);
  return p;
}
function partSeconds(ffmpeg, file) {
  try {
    const size = fs.statSync(file).size;
    const out = spawnSync(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8', timeout: 8000 }).stderr || '';
    const m = out.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
    if (m) return +m[1] * 3600 + +m[2] * 60 + parseFloat(m[3]);
    // A part cut off by a relaunch has no duration in its header: read it through (copy, fast) and take the last time=.
    const r = spawnSync(ffmpeg, ['-hide_banner', '-i', file, '-map', '0', '-c', 'copy', '-f', 'null', '-'], { encoding: 'utf8', timeout: 60000 }).stderr || '';
    const t = [...r.matchAll(/time=\s*(\d+):(\d+):([\d.]+)/g)].pop();
    return t ? +t[1] * 3600 + +t[2] * 60 + parseFloat(t[3]) : size > 2e6 ? Infinity : 0;
  } catch { return 0; }
}
async function finishShowRecording(s) {
  const rec = s && s.showRec;
  if (!rec || rec.finishing) return;
  rec.finishing = true;
  const sender = s.sender;
  // No camera from the start: the show went to the radio and nothing was recorded. Just end the REC indicator.
  if (!rec.parts.length) { safeSend(sender, 'recording-stopped', {}); return; }
  // The stream's ffmpeg writes the Matroska trailer when it exits after SIGTERM.
  const deadline = Date.now() + 8000;
  while (s.showProcs.some(p => p.exitCode === null && p.signalCode === null) && Date.now() < deadline) await new Promise(r => setTimeout(r, 200));
  const ffmpeg = findFFmpeg();
  const keep = rec.parts.filter(p => fs.existsSync(p) && partSeconds(ffmpeg, p) >= 6);
  rec.parts.filter(p => !keep.includes(p)).forEach(p => { try { fs.unlinkSync(p); } catch {} });
  if (!keep.length) { safeSend(sender, 'recording-stopped', { note: 'No show recording: the video never got on air.' }); return; }
  const out = path.join(rec.folder, `${rec.base}.mp4`);
  safeSend(sender, 'recording-log', { msg: 'Saving the show as MP4…' });
  let list = null, args;
  if (keep.length === 1) args = ['-hide_banner', '-y', '-i', keep[0], '-c', 'copy', '-movflags', '+faststart', out];
  else {
    list = path.join(rec.folder, `${rec.base}-parts.txt`);
    fs.writeFileSync(list, keep.map(p => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n') + '\n');
    args = ['-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out];
  }
  const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  proc.stderr.on('data', d => { err = (err + d).slice(-4000); });
  proc.on('close', code => {
    if (list) { try { fs.unlinkSync(list); } catch {} }
    if (code === 0) {
      keep.forEach(p => { try { fs.unlinkSync(p); } catch {} });
      safeSend(sender, 'recording-stopped', { path: out });
    } else {
      safeSend(sender, 'recording-stopped', { error: `Saving the show as MP4 failed (${err.trim().split('\n').pop()}). The recording is kept as ${keep.map(p => path.basename(p)).join(', ')}.` });
    }
  });
  proc.on('error', e => safeSend(sender, 'recording-stopped', { error: `Saving the show failed (${e.message}). The .mkv parts are kept.` }));
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────

ipcMain.handle('load-config', () => loadConfig());

ipcMain.handle('save-config', (_, cfg) => {
  saveConfig(cfg);
  return { ok: true };
});

ipcMain.handle('get-platform', () => process.platform);

// ─── Find sox ────────────────────────────────────────────────────────────────
function findSox() {
  const candidates = [
    path.join(process.resourcesPath || '', 'sox'),
    '/usr/local/bin/sox',
    'sox'
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return 'sox';
}

function startSoxStream(event, profile, quality, deviceName, audioChannels, volume) {
  const ffmpeg = findFFmpeg();
  const sox = findSox();
  const label = profile.name || profile.type;
  const sampleRate = quality.audioSampleRate || 44100;
  const bitrate = quality.audioBitrate || '320k';
  const vol = Math.max(0, Math.min(100, volume ?? 100)) / 100;

  // Parse channel selection
  const parts = (audioChannels || '0,1').split(',');
  const cL = parseInt(parts[0]) || 0;
  const cR = parseInt(parts[1] !== undefined ? parts[1] : parts[0]) || 1;

  // Build Icecast URL
  const server = profile.server || 'localhost';
  const serverWithPort = server.includes(':') ? server : `${server}:8000`;
  const iceUser = profile.username || 'source';
    const url = `icecast://${iceUser}:${profile.password || 'hackme'}@${serverWithPort}${profile.mount || '/stream'}`;

  // Capture enough channels to cover the selected pair (e.g. "4,5" needs 6ch)
  const soxChannels = Math.max(2, cL + 1, cR + 1);

  // sox args: capture from CoreAudio device → raw signed 16-bit PCM to stdout
  const soxArgs = [
    '-t', 'coreaudio', deviceName,
    '--buffer', '16384',          // larger buffer reduces underruns/pops
    '-t', 'raw', '-r', String(sampleRate), '-e', 'signed', '-b', '16', '-c', String(soxChannels), '-'
  ];

  // ffmpeg args: read raw PCM from stdin → encode MP3 → stream to Icecast
  const ffmpegArgs = [
    '-f', 's16le', '-ar', String(sampleRate), '-ac', String(soxChannels), '-i', 'pipe:0',
    '-af', `pan=stereo|c0=c${cL}|c1=c${cR},volume=${vol}`,
    '-acodec', 'libvorbis', '-q:a', '6', '-ar', String(sampleRate), '-ac', '2',
    '-f', 'ogg', '-content_type', 'audio/ogg',
    '-reconnect', '1',             // auto-reconnect on network drop
    '-reconnect_delay_max', '5',   // wait max 5s before reconnect
    url,
    ...meterTapArgs(0, `pan=stereo|c0=c${cL}|c1=c${cR},volume=${vol}`),
  ];

  safeSend(event.sender, 'stream-log', { type: 'info', msg: `Starting ${label} (CoreAudio via sox) — device: "${deviceName}"`, tech: true });
  safeSend(event.sender, 'stream-log', { type: 'info', msg: `CMD: sox ${soxArgs.join(' ')} | ffmpeg ${ffmpegArgs.join(' ')}`, tech: true });

  // Spawn sox
  const soxProc = tagProc(spawn(sox, soxArgs));
  // Spawn ffmpeg reading from sox stdout
  const ffmpegProc = tagProc(spawn(ffmpeg, ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] }));

  // Pipe sox stdout → ffmpeg stdin
  soxProc.stdout.pipe(ffmpegProc.stdin);
  attachMeterTap(ffmpegProc, event.sender);

  soxProc.stderr.on('data', d => {
    const line = d.toString().trim();
    if (line) safeSend(event.sender, 'stream-log', { type: 'info', msg: `[sox] ${line}`, tech: true });
    if (line) superviseLine(soxProc, line);
  });

  ffmpegProc.stderr.on('data', (data) => {
    const lines = data.toString().split(/[\r\n]+/).filter(l => l.trim());
    lines.forEach(line => {
      superviseLine(ffmpegProc, line);
      if (line.includes('size=') || line.includes('time=')) {
        const match = line.match(/bitrate=\s*([\d.]+)kbits/);
        safeSend(event.sender, 'stream-stats', { label, bitrate: match ? match[1] : null, raw: line });
      } else if (line.includes('Error') || line.includes('error') || line.includes('failed')) {
        safeSend(event.sender, 'stream-log', { type: 'error', msg: `[${label}] ${line}`, tech: true });
      } else if (line.includes('Audio:') || line.includes('Stream #')) {
        safeSend(event.sender, 'stream-log', { type: 'info', msg: `[${label}] ${line}`, tech: true });
      }
    });
  });

  soxProc.on('error', e => safeSend(event.sender, 'stream-log', { type: 'error', msg: `[sox] ${e.message}`, tech: true }));
  ffmpegProc.on('error', e => safeSend(event.sender, 'stream-log', { type: 'error', msg: `[ffmpeg] ${e.message}`, tech: true }));

  soxProc.on('close', (code) => {
    if (isStreaming && !(liveSession && (soxProc._gen !== liveSession.gen || liveSession.tearingDown))) {
      safeSend(event.sender, 'stream-log', { type: 'error', msg: `[sox] Exited (code ${code}): the input "${deviceName}" may not be available.`, tech: true });
      if (liveSession) { liveSession.stage = 'device'; liveSession.lastLine = `sox exited (code ${code})`; }
      // sox dying closes the pipe → ffmpeg will exit too; kill it explicitly to be clean
      try { ffmpegProc.kill('SIGTERM'); } catch {}
    }
  });

  ffmpegProc.on('close', (code) => {
    const idx = activeProcesses.indexOf(ffmpegProc);
    if (idx > -1) activeProcesses.splice(idx, 1);
    const idx2 = activeProcesses.indexOf(soxProc);
    if (idx2 > -1) activeProcesses.splice(idx2, 1);
    if (pipelineExited(ffmpegProc, code)) return;
    if (isStreaming) {
      safeSend(event.sender, 'stream-log', { type: code === 0 ? 'info' : 'error', msg: `[${label}] Stream ended (code ${code})`, tech: true });
      if (activeProcesses.filter(p => !p.killed).length === 0) {
        isStreaming = false;
        safeSend(event.sender, 'stream-stopped', {});
      }
    }
  });

  activeProcesses.push(soxProc, ffmpegProc);
  safeSend(event.sender, 'stream-log', { type: 'success', msg: `✓ ${label} stream started`, tech: true });
  return { soxProc, ffmpegProc };
}

// Video stream: canvas → IPC pipe → ffmpeg stdin (video) + sox CoreAudio pipe → ffmpeg fd3 (audio).
// Single-clock audio via sox CoreAudio (same as Icecast path) — no AVFoundation epoch timestamp issues.
let videoFfmpegProc = null; // ffmpeg process reading raw video from stdin
let videoSoxProc = null;    // sox process piping audio to ffmpeg fd3

function startVideoStream(event, ffmpeg, profiles, quality, audioDeviceName, volume, audioChannels, recordingPath) {
  const sox = findSox();
  const fps = quality.fps || 30;
  const vol = Math.max(0, Math.min(100, volume ?? 100)) / 100;
  const parts = (audioChannels || '0,1').split(',');
  const cL = parseInt(parts[0]) || 0;
  const cR = parseInt(parts[1] !== undefined ? parts[1] : parts[0]) || 1;
  const sampleRate = quality.audioSampleRate || 44100;
  const soxChannels = Math.max(2, cL + 1, cR + 1);

  // Video: webm/vp8 chunks from renderer MediaRecorder via stdin (pipe:0)
  // Audio: sox CoreAudio → s16le PCM → ffmpeg fd3 (pipe:3) — same stable path as Icecast
  const args = [
    '-thread_queue_size', '1024',
    '-f', 'webm', '-i', 'pipe:0',
    '-thread_queue_size', '1024',
    '-f', 's16le', '-ar', String(sampleRate), '-ac', String(soxChannels), '-i', 'pipe:3',
    '-af', `pan=stereo|c0=c${cL}|c1=c${cR},volume=${vol}`,
    // Re-encode vp8→h264 for RTMP/FLV
    '-vf', `setpts=PTS-STARTPTS,format=yuv420p`,
    '-vcodec', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
    '-threads', '0', '-crf', '28',
    '-maxrate', quality.videoBitrate || '1000k',
    '-bufsize', String(parseInt(quality.videoBitrate || '1000k') * 2) + 'k',
    '-r', String(fps), '-g', String(fps * 2), '-keyint_min', String(fps),
    '-acodec', 'aac', '-b:a', quality.audioBitrate || '192k', '-ar', '44100', '-ac', '2',
    '-max_muxing_queue_size', '1024',
  ];

  // Add outputs
  const rtmpProfiles2 = profiles.filter(p => p.type !== 'icecast' && p.type !== 'shoutcast');
  const icecastProfiles = profiles.filter(p => p.type === 'icecast' || p.type === 'shoutcast');

  rtmpProfiles2.forEach(p => {
    const url = rtmpUrlOf(p);
    // Same local show recording as buildTeeArgs (1.6.0): video from the canvas pipe (0), audio from sox (1).
    if (recordingPath) args.push('-map', '0:v', '-map', '1:a', '-flags:v', '+global_header', '-flags:a', '+global_header',
      '-f', 'tee', `[f=flv:flvflags=no_duration_filesize]${url}|[f=matroska:onfail=ignore]${teePath(recordingPath)}`);
    else args.push('-f', 'flv', url);
  });
  // Icecast outputs: audio-only from input 1 (sox pipe)
  icecastProfiles.forEach(p => {
    const server = p.server || 'localhost';
    const serverWithPort = server.includes(':') ? server : `${server}:8000`;
    const iceUser = p.username || 'source';
    const url = `icecast://${iceUser}:${p.password || 'hackme'}@${serverWithPort}${p.mount || '/stream'}`;
    args.push('-map', '1:a', '-c:a', 'libvorbis', '-q:a', '6', '-ar', '44100', '-ac', '2', '-f', 'ogg', '-content_type', 'audio/ogg', url);
  });
  args.push(...meterTapArgs(1, `pan=stereo|c0=c${cL}|c1=c${cR},volume=${vol}`));

  // sox: CoreAudio → raw s16le PCM to stdout (capture enough channels for selected pair)
  const soxArgs = [
    '-t', 'coreaudio', audioDeviceName || '',
    '--buffer', '16384',
    '-t', 'raw', '-r', String(sampleRate), '-e', 'signed', '-b', '16', '-c', String(soxChannels), '-'
  ];

  safeSend(event.sender, 'stream-log', { type: 'info', msg: `CMD: ffmpeg ${args.join(' ')}`, tech: true });

  // 1.6.1 (Mac test, 22 Oct): sox used to start first, while ffmpeg still probed the camera's webm (about 6 s). The
  // pipe filled, CoreAudio dropped audio ("unhandled buffer overrun", 1012 times in one live minute), and the show
  // file came out short. Now ffmpeg starts first and sox only once ffmpeg has opened its video input ("Input #0").
  // Every 10 s one tech line says how fast ffmpeg runs and how often sox dropped audio, so a slow Mac shows itself.
  let cmd = ffmpeg, spawnArgs = args;
  if (process.platform !== 'win32') {
    cmd = 'nice';
    spawnArgs = ['-n', '-10', ffmpeg, ...args];
  }
  // stdio: [stdin=video pipe, stdout=pipe, stderr=pipe, fd3=audio from sox]
  const proc = spawn(cmd, spawnArgs, { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
  videoFfmpegProc = proc;
  activeProcesses.push(proc);
  attachMeterTap(proc, event.sender);
  proc.stdio[3].on('error', () => {});

  let soxProc = null, overruns = 0, lastProgress = '';
  const startSox = () => {
    if (soxProc || proc.exitCode !== null) return;
    safeSend(event.sender, 'stream-log', { type: 'info', msg: `Starting sox — device: "${audioDeviceName}"`, tech: true });
    soxProc = spawn(sox, soxArgs);
    videoSoxProc = soxProc;
    activeProcesses.push(soxProc);
    soxProc.stderr.on('data', d => {
      d.toString().split('\n').map(l => l.trim()).filter(Boolean).forEach(line => {
        if (/buffer overrun/i.test(line)) { overruns++; return; } // counted, reported every 10 s
        safeSend(event.sender, 'stream-log', { type: 'info', msg: `[sox] ${line}`, tech: true });
      });
    });
    soxProc.on('error', e => safeSend(event.sender, 'stream-log', { type: 'error', msg: `[sox] ${e.message}`, tech: true }));
    soxProc.on('close', (code) => {
      const idx = activeProcesses.indexOf(soxProc);
      if (idx > -1) activeProcesses.splice(idx, 1);
      if (videoSoxProc === soxProc) videoSoxProc = null;
      if (isStreaming) {
        safeSend(event.sender, 'stream-log', { type: 'error', msg: `[sox] Exited (code ${code}) — audio device "${audioDeviceName}" may not be available.` });
        try { if (videoFfmpegProc) videoFfmpegProc.kill('SIGTERM'); } catch {}
      }
    });
    soxProc.stdout.pipe(proc.stdio[3]);
  };
  const soxFallback = setTimeout(startSox, 15000); // ffmpeg never said "Input #0": start anyway, the log shows why
  const health = setInterval(() => {
    if (proc.exitCode !== null) return;
    const t = (lastProgress.match(/time=\s*(\S+)/) || [])[1], sp = (lastProgress.match(/speed=\s*(\S+)/) || [])[1];
    safeSend(event.sender, 'stream-log', { type: overruns ? 'warn' : 'info', tech: true,
      msg: `[mac video] ffmpeg time=${t || '?'} speed=${sp || '?'} · sox dropped audio ${overruns}× in the last 10 s` });
    overruns = 0;
  }, 10000);
  proc.on('close', () => { clearTimeout(soxFallback); clearInterval(health); });

  proc.stderr.on('data', (data) => {
    const lines = data.toString().split(/[\r\n]+/).filter(l => l.trim());
    lines.forEach(line => {
      if (/^Input #0/.test(line.trim())) { clearTimeout(soxFallback); startSox(); }
      if (line.includes('size=') || line.includes('time=')) {
        lastProgress = line;
        const match = line.match(/bitrate=\s*([\d.]+)kbits/);
        safeSend(event.sender, 'stream-stats', { bitrate: match ? match[1] : null });
      } else if (line.match(/error|Error|failed|Broken pipe/i) && !line.includes('Qavg')) {
        safeSend(event.sender, 'stream-log', { type: 'error', msg: line, tech: true });
      } else if (line.includes('Stream #') || line.includes('Output #')) {
        safeSend(event.sender, 'stream-log', { type: 'info', msg: line, tech: true });
      }
    });
  });
  proc.on('close', (code) => {
    const idx = activeProcesses.indexOf(proc);
    if (idx > -1) activeProcesses.splice(idx, 1);
    if (videoFfmpegProc === proc) videoFfmpegProc = null;
    if (isStreaming && activeProcesses.filter(p => !p.killed).length === 0) {
      isStreaming = false;
      safeSend(event.sender, 'stream-stopped', {});
      finishShowRecording(liveSession); // unsupervised: the show ended without STOP
    }
  });
  safeSend(event.sender, 'stream-log', { type: 'success', msg: '✓ Video stream started (sox audio + canvas video)', tech: true });
  return proc;
}

// Receive raw RGBA video frames from renderer canvas and pipe to ffmpeg stdin
ipcMain.on('video-chunk', (_, buffer) => {
  try {
    if (videoFfmpegProc && videoFfmpegProc.stdin && !videoFfmpegProc.stdin.destroyed) {
      const buf = buffer instanceof Buffer ? buffer : Buffer.from(buffer);
      videoFfmpegProc.stdin.write(buf);
    }
  } catch(e) {
    // pipe may close during stream stop — ignore
  }
});

function spawnFFmpeg(event, ffmpeg, args) {
  // Use nice -n -10 on macOS/Linux to give ffmpeg higher scheduling priority
  let cmd = ffmpeg, spawnArgs = args;
  if (process.platform !== 'win32') {
    cmd = 'nice';
    spawnArgs = ['-n', '-10', ffmpeg, ...args];
  }
  safeSend(event.sender, 'stream-log', { type: 'info', msg: `CMD: ffmpeg ${args.join(' ')}`, tech: true });
  const proc = tagProc(spawn(cmd, spawnArgs, { stdio: ['pipe', 'pipe', 'pipe'] }));
  proc._qStop = true; // stdin only carries 'q' (stopAllStreams)
  proc.stdin.on('error', () => {});
  activeProcesses.push(proc);
  attachMeterTap(proc, event.sender);
  proc.stderr.on('data', (data) => {
    const lines = data.toString().split(/[\r\n]+/).filter(l => l.trim());
    lines.forEach(line => {
      superviseLine(proc, line);
      if (line.includes('size=') || line.includes('time=')) {
        if (liveSession && proc._gen === liveSession.gen && !progressConfirmed(liveSession)) return;
        const match = line.match(/bitrate=\s*([\d.]+)kbits/);
        safeSend(event.sender, 'stream-stats', { bitrate: match ? match[1] : null });
      } else if (line.match(/error|Error|failed|Broken pipe/i) && !line.includes('Qavg')) {
        safeSend(event.sender, 'stream-log', { type: 'error', msg: line, tech: true });
      } else if (line.includes('Stream #') || line.includes('Output #')) {
        safeSend(event.sender, 'stream-log', { type: 'info', msg: line, tech: true });
      }
    });
  });
  proc.on('close', (code) => {
    const idx = activeProcesses.indexOf(proc);
    if (idx > -1) activeProcesses.splice(idx, 1);
    if (pipelineExited(proc, code)) return;
    if (isStreaming && activeProcesses.filter(p => !p.killed).length === 0) {
      isStreaming = false;
      safeSend(event.sender, 'stream-stopped', {});
    }
  });
  safeSend(event.sender, 'stream-log', { type: 'success', msg: '✓ Stream started', tech: true });
  return proc;
}

ipcMain.handle('start-stream', async (event, opts) => {
  if (isStreaming) return { ok: false, error: 'Already streaming' };
  stopPreviewMeter();
  const activeProfiles = opts.profiles.filter(p => p.enabled);
  if (activeProfiles.length === 0) return { ok: false, error: 'No destinations enabled' };
  // Grooveline only, one destination per show (1.4.0): the radio (Icecast) or the video server (MediaMTX).
  // Two at once would take buildTeeArgs' multi-output branch, which never worked for video.
  if (activeProfiles.length !== 1 || !['icecast', 'mediamtx'].includes(activeProfiles[0].type)) {
    return { ok: false, error: 'This app streams to one Grooveline destination at a time: your radio slot or your video slot.' };
  }
  if (activeProfiles[0].type === 'mediamtx' && !rtmpUrlOf(activeProfiles[0])) {
    return { ok: false, error: 'Your video slot has no stream key. Press ↻ on your slot to load it again.' };
  }
  opts.profiles = activeProfiles;
  opts.audioOnly = activeProfiles[0].type === 'icecast';
  const fb = opts.fallbackProfile;
  opts.fallbackProfile = !opts.audioOnly && fb && fb.type === 'icecast' ? { ...fb, enabled: true } : null;
  // A sound check must never reach a public mount: exactly one Icecast
  // destination, on a private /check-* mount, audio only — or nothing streams.
  if (opts.soundCheck) {
    const p = activeProfiles[0];
    if (activeProfiles.length !== 1 || p.type !== 'icecast' || !/^\/check-[a-z0-9-]+$/i.test(p.mount || '')) {
      return { ok: false, error: 'Stream check refused: it only streams to your private test mount.' };
    }
    opts.profiles = [p];
    opts.audioOnly = true;
  }

  isStreaming = true;
  streamStartTime = Date.now();
  endLiveSession();
  const hasRtmp = activeProfiles.some(p => p.type !== 'icecast' && p.type !== 'shoutcast');
  liveSession = {
    event, sender: event.sender, opts, gen: 1, attempt: 0, sameStageFails: 0, prevStage: null, sessionStart: Date.now(),
    soundCheck: !!opts.soundCheck,
    // The macOS canvas-video path can't be relaunched mid-stream (the renderer's
    // webm stream has no header after a restart) — it keeps the old behaviour.
    supervise: !(process.platform === 'darwin' && hasRtmp && !opts.audioOnly),
    launchedAt: Date.now(), lastProgress: 0, stage: null, lastLine: '', firstProgressAt: 0, confirmed: false,
    showRec: !opts.audioOnly && !opts.soundCheck && opts.recordFolder
      ? { folder: opts.recordFolder, base: `grooveline-show-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`, parts: [] } : null,
    showProcs: [],
  };
  const needAudioName = !opts.audioDeviceName || opts.audioDeviceName === 'default';
  if (process.platform === 'win32' && (needAudioName || !opts.audioOnly)) {
    const { devices, videoDevices } = await listDshowDevices();
    // launchPipeline (sync, also run by every relaunch) picks the camera from this list.
    opts._dshowCams = videoDevices;
    // DirectShow has no device called "default" — pick the first real input
    // rather than fail with "Error opening input file audio=default".
    // 1.6.1: never stream the first input in the list when the picked one wasn't found. On a Mac that silently sent
    // a loopback driver (silence) for a whole show; DirectShow has the same trap.
    if (needAudioName) {
      endLiveSession(); isStreaming = false;
      return { ok: false, error: devices.length ? 'Pick your input under YOUR INPUT: the app could not tell which device it is.'
        : 'No audio inputs found (DirectShow). Plug in your controller or interface, then press GO LIVE again.' };
    }
  }
  const r = launchPipeline(event, opts);
  if (!r.ok) {
    reportSetup('app_error', { stage: 'launch', detail: r.error });
    endLiveSession();
    isStreaming = false;
    return r;
  }
  startWatchdog();
  return r;
});

// Windows/Linux video: use a camera that exists right now. "Default Camera", an old saved index or an unplugged
// camera become the first one found; no camera at all → the radio fallback, or a clear error.
// macOS checks in the renderer instead: Chromium owns the camera there (canvas capture).
function pickCamera(event, opts) {
  if (opts.audioOnly || process.platform === 'darwin') return null;
  const cams = process.platform === 'win32' ? (opts._dshowCams || []) : listV4l2Devices();
  if (!cams.length) {
    if (fallBackToRadio(event.sender, opts, 'No camera found')) return null;
    return 'No camera found. Plug one in and press GO LIVE again (this slot has no radio mount to fall back to; load your slot in Destinations).';
  }
  if (process.platform === 'win32') {
    if (!cams.some(c => c.name === opts.videoDeviceName)) opts.videoDeviceName = cams[0].name;
  } else if (!cams.some(c => c.path === opts.videoDevice)) {
    opts.videoDevice = cams[0].path;
  }
  return null;
}

// Starts every process for one GO LIVE (also used by the supervisor to relaunch).
function launchPipeline(event, opts) {
  const camErr = pickCamera(event, opts);
  if (camErr) return { ok: false, error: camErr, stage: 'camera' };
  const { profiles, quality, audioDevice, audioDeviceName, audioChannels, videoDevice, videoDeviceName, audioOnly, volume } = opts;
  const activeProfiles = profiles.filter(p => p.enabled);
  const ffmpeg = findFFmpeg();

  // macOS: sox for all Icecast/SHOUTcast (stable CoreAudio path),
  // canvas→pipe ffmpeg for all RTMP/video profiles (no AVFoundation camera — Chromium owns it).
  // These do NOT conflict — sox uses CoreAudio API, canvas pipe uses stdin.
  if (process.platform === 'darwin') {
    let launched = 0;
    const devName = audioDeviceName || 'default'; // sox: "default" = CoreAudio's default input; "" opens nothing
    const iceProfiles = activeProfiles.filter(p => p.type === 'icecast' || p.type === 'shoutcast');
    const rtmpProfiles = activeProfiles.filter(p => p.type !== 'icecast' && p.type !== 'shoutcast');

    iceProfiles.forEach(profile => {
      try { startSoxStream(event, profile, quality, devName, audioChannels, volume); launched++; }
      catch(e) { safeSend(event.sender, 'stream-log', { type: 'error', msg: `✗ Failed: ${e.message}` }); }
    });

    if (rtmpProfiles.length > 0 && !audioOnly) {
      try {
        const recPath = nextShowPart(opts);
        const proc = startVideoStream(event, ffmpeg, rtmpProfiles, quality, devName, volume, audioChannels, recPath);
        if (proc) launched++;
        if (proc && recPath && liveSession) liveSession.showProcs.push(proc);
      } catch(e) {
        safeSend(event.sender, 'stream-log', { type: 'error', msg: `✗ Video stream failed: ${e.message}` });
      }
    } else if (rtmpProfiles.length > 0 && audioOnly) {
      // Audio-only RTMP (no video device selected)
      rtmpProfiles.forEach(profile => {
        try { startSoxStream(event, profile, quality, devName, audioChannels, volume); launched++; }
        catch(e) { safeSend(event.sender, 'stream-log', { type: 'error', msg: `✗ Failed: ${e.message}` }); }
      });
    }

    if (launched === 0) return { ok: false, error: 'Failed to launch stream' };
    return { ok: true, launched };
  }

  // Windows / Linux: single ffmpeg for all profiles
  const recPath = nextShowPart(opts);
  const args = buildTeeArgs(activeProfiles, quality, audioDevice, videoDevice, audioOnly, volume, audioChannels, audioDeviceName, videoDeviceName, recPath, null,
    label => { if (liveSession && liveSession.camLabel !== label) { liveSession.camLabel = label; safeSend(event.sender, 'stream-log', { type: 'info', msg: `Camera: ${label}`, tech: true }); } });
  try {
    const proc = spawnFFmpeg(event, ffmpeg, args);
    if (!proc) return { ok: false, error: 'Failed to launch' };
    if (recPath && liveSession) liveSession.showProcs.push(proc);
    return { ok: true, launched: 1 };
  } catch(e) {
    return { ok: false, error: e.message };
  }
}

ipcMain.handle('stop-stream', (event) => {
  const s = liveSession;
  stopAllStreams();
  safeSend(event.sender, 'stream-log', { type: 'info', msg: 'Stream stopped by user' });
  finishShowRecording(s);
  return { ok: true };
});

// ─── PCM Pipe Stream (CoreAudio via Web Audio → ffmpeg stdin) ─────────────────
// Bypasses AVFoundation entirely — Web Audio uses CoreAudio directly like BUTT
let pcmProcesses = [];

ipcMain.handle('start-pcm-stream', async (event, { profiles, quality, volume, audioChannels }) => {
  if (isStreaming) return { ok: false, error: 'Already streaming' };

  const ffmpeg = findFFmpeg();
  const activeProfiles = profiles.filter(p => p.enabled);
  if (activeProfiles.length === 0) return { ok: false, error: 'No destinations enabled' };

  const sampleRate = quality.audioSampleRate || 44100;
  const bitrate = quality.audioBitrate || '320k';
  const vol = Math.max(0, Math.min(100, volume ?? 100)) / 100;

  // Parse channel selection
  const parts = (audioChannels || '0,1').split(',');
  const cL = parseInt(parts[0]) || 0;
  const cR = parseInt(parts[1] !== undefined ? parts[1] : parts[0]) || 1;

  isStreaming = true;
  streamStartTime = Date.now();
  pcmProcesses = [];

  activeProfiles.forEach(profile => {
    const label = profile.name || profile.type;

    // ffmpeg reads raw float32 stereo PCM from stdin, encodes to AAC/MP3, streams to Icecast
    const server = profile.server || 'localhost';
    const serverWithPort = server.includes(':') ? server : `${server}:8000`;
    const iceUser = profile.username || 'source';
    const url = `icecast://${iceUser}:${profile.password || 'hackme'}@${serverWithPort}${profile.mount || '/stream'}`;

    const args = [
      '-thread_queue_size', '4096',  // large input queue — prevents glitches when IPC is momentarily delayed
      '-f', 'f32le',                 // raw 32-bit float PCM input
      '-ar', String(sampleRate),
      '-ac', '2',                    // stereo (already mixed from selected channels in renderer)
      '-i', 'pipe:0',                // read from stdin
      '-af', `volume=${vol}`,
      '-acodec', 'libvorbis',
      '-q:a', '6',
      '-ar', String(sampleRate),
      '-ac', '2',
      '-f', 'ogg',
      '-content_type', 'audio/ogg',
      url
    ];

    safeSend(event.sender, 'stream-log', { type: 'info', msg: `Starting ${label} (CoreAudio mode)...` });
    safeSend(event.sender, 'stream-log', { type: 'info', msg: `CMD: ffmpeg ${args.join(' ')}` });

    try {
      const proc = spawn(ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      pcmProcesses.push(proc);
      activeProcesses.push(proc);

      proc.stderr.on('data', (data) => {
        const lines = data.toString().split('\n').filter(l => l.trim());
        lines.forEach(line => {
          if (line.includes('size=') || line.includes('time=')) {
            const match = line.match(/bitrate=\s*([\d.]+)kbits/);
            safeSend(event.sender, 'stream-stats', { label, bitrate: match ? match[1] : null, raw: line });
          } else if (line.includes('Error') || line.includes('error') || line.includes('failed')) {
            safeSend(event.sender, 'stream-log', { type: 'error', msg: `[${label}] ${line}` });
          } else if (line.includes('Audio:') || line.includes('Stream #')) {
            safeSend(event.sender, 'stream-log', { type: 'info', msg: `[${label}] ${line}` });
          }
        });
      });

      proc.on('close', (code) => {
        const idx = activeProcesses.indexOf(proc);
        if (idx > -1) activeProcesses.splice(idx, 1);
        if (isStreaming) {
          safeSend(event.sender, 'stream-log', { type: code === 0 ? 'info' : 'error', msg: `[${label}] Process exited (code ${code})` });
        }
        if (activeProcesses.length === 0 && isStreaming) {
          isStreaming = false;
          safeSend(event.sender, 'stream-stopped', {});
        }
      });

      safeSend(event.sender, 'stream-log', { type: 'success', msg: `✓ ${label} stream started` });
    } catch (e) {
      safeSend(event.sender, 'stream-log', { type: 'error', msg: `✗ Failed: ${e.message}` });
    }
  });

  return { ok: true };
});

// Renderer sends PCM chunks — pipe to all active ffmpeg stdin
ipcMain.handle('stop-pcm-stream', (event) => {
  pcmProcesses.forEach(proc => { try { proc.stdin.end(); } catch {} });
  pcmProcesses = [];
  stopAllStreams();
  safeSend(event.sender, 'stream-log', { type: 'info', msg: 'Stream stopped by user' });
  return { ok: true };
});

// ─── Recording ───────────────────────────────────────────────────────────────
let recordingProcess = null;
let recordingPath = null;

ipcMain.handle('open-folder-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Choose Recording Folder'
  });
  return result.canceled ? null : result.filePaths[0];
});

// Recording: MediaRecorder chunks streamed to a .webm temp file,
// converted by ffmpeg on stop.
let recWriteStream = null;
let recTmpPath = null;
let recOutPath = null;
let recFormat2 = 'aac';
let recMode = 'webm'; // 'webm' = MediaRecorder chunks, 'pcm' = tap from pcm-chunk
let recFfmpegProc = null; // ffmpeg process for pcm-tap recording
let recSampleRate = 44100;

ipcMain.handle('start-recording', async (event, { format, folder, mode, sampleRate, audioDevice, videoDevice, audioOnly, quality, cam }) => {
  if (recWriteStream || recFfmpegProc) return { ok: false, error: 'Already recording' };
  recFormat2 = format || 'aac';
  recMode = mode || 'webm';
  // Live recording ('pcm') is fed by the meter tap, which is always 44.1 kHz float stereo (1.5.0).
  recSampleRate = recMode === 'pcm' ? TAP_RATE : (sampleRate || 44100);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const ext = recFormat2 === 'wav' ? 'wav' : recFormat2 === 'mp4' ? 'mp4' : 'aac';
  recOutPath = path.join(folder, `grooveline-rec-${timestamp}.${ext}`);

  // AVFoundation direct capture mode: not live, video selected — capture camera+mic directly to MP4
  if (recMode === 'avf' && process.platform === 'darwin') {
    const ffmpeg = findFFmpeg();
    const avVideo = String(videoDevice || '0');
    const avAudio = /^\d+$/.test(String(audioDevice)) ? audioDevice : '0';
    const sz = (quality && quality.videoSize) || '1280x720';
    const _sz = (() => {
      const m = sz.match(/^(\d+)x(\d+)$/);
      if (m) { const w=parseInt(m[1]), h=parseInt(m[2]); return (w>1280||h>720) ? '1280x720' : sz; }
      return '1280x720';
    })();
    const fps = (quality && quality.fps) || 30;
    const vbr = (quality && quality.videoBitrate) || '3000k';
    const abr = (quality && quality.audioBitrate) || '192k';
    const ffArgs = [
      '-f', 'avfoundation',
      '-framerate', String(fps),
      '-thread_queue_size', '512',
      '-probesize', '32',
      '-analyzeduration', '0',
      '-i', `${avVideo}:${avAudio}`,
      '-vf', (()=>{ const [w,h]=_sz.split('x'); return `format=yuv420p,scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`; })(),
      '-vcodec', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
      '-threads', '0',
      '-b:v', vbr, '-maxrate', vbr, '-bufsize', String(parseInt(vbr) * 4) + 'k',
      '-r', String(fps),
      '-acodec', 'aac', '-b:a', abr, '-ar', '44100', '-ac', '2',
      '-f', 'mp4', '-movflags', '+faststart',
      '-y', recOutPath
    ];
    try {
      const recCmd = process.platform !== 'win32' ? 'nice' : ffmpeg;
      const recSpawnArgs = process.platform !== 'win32' ? ['-n', '-10', ffmpeg, ...ffArgs] : ffArgs;
      recFfmpegProc = spawn(recCmd, recSpawnArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
      let errOut = '';
      recFfmpegProc.stderr.on('data', d => { errOut += d.toString(); });
      recFfmpegProc.on('close', (code) => {
        recFfmpegProc = null;
        if (code === 0 || code === 255) {
          safeSend(mainWindow.webContents, 'recording-stopped', { path: recOutPath });
        } else {
          const errLine = errOut.split('\n').filter(l=>l.trim()).slice(-3).join(' | ');
          safeSend(mainWindow.webContents, 'recording-stopped', { error: 'AVF recording failed: ' + errLine });
        }
        recOutPath = null;
      });
      recFfmpegProc.on('error', (err) => {
        recFfmpegProc = null; recOutPath = null;
        safeSend(mainWindow.webContents, 'recording-stopped', { error: err.message });
      });
      recWriteStream = true;
      safeSend(mainWindow.webContents, 'recording-log', { msg: `● MP4 recording (camera)…` });
      return { ok: true };
    } catch(e) {
      return { ok: false, error: e.message };
    }
  }

  // Camera + input to MP4 while not live, Linux and Windows (1.6.0; until then MP4 held only audio there). The page
  // stops its preview first so ffmpeg can open the camera; on Linux we also wait until Chromium has let go of it.
  if (recMode === 'cam' && process.platform !== 'darwin' && cam) {
    const ffmpeg = findFFmpeg();
    const size = streamSize(quality || {});
    const [w, h] = size.split('x');
    const fps = (quality && quality.fps) || 30;
    const parts = (cam.audioChannels || '0,1').split(',');
    const cL = parseInt(parts[0]) || 0, cR = parseInt(parts[1] !== undefined ? parts[1] : parts[0]) || 1;
    const vol = Math.max(0, Math.min(100, cam.volume ?? 100)) / 100;
    const ffArgs = ['-hide_banner'];
    if (process.platform === 'win32') {
      const cams = (await listDshowDevices()).videoDevices || [];
      const name = cams.some(c => c.name === cam.videoDeviceName) ? cam.videoDeviceName : (cams[0] || {}).name;
      if (!name) return { ok: false, error: 'No camera found.' };
      ffArgs.push('-f', 'dshow', ...dshowVideoArgs(name, size).args, '-framerate', String(fps), '-audio_buffer_size', '50',
        '-i', `video=${name}:audio=${cam.audioDeviceName || 'default'}`, '-map', '0:v', '-map', '0:a');
    } else {
      const devs = listV4l2Devices();
      const dev = devs.some(d => d.path === cam.videoDevice) ? cam.videoDevice : (devs[0] || {}).path;
      if (!dev) return { ok: false, error: 'No camera found.' };
      for (let t = Date.now(); videoHolders().length && Date.now() - t < 2500;) await new Promise(r => setTimeout(r, 100));
      const capCh = Math.max(2, cL + 1, cR + 1);
      ffArgs.push('-f', 'v4l2', ...v4l2InputArgs(dev, size).args, '-framerate', String(fps), '-thread_queue_size', '512', '-i', dev,
        '-f', 'pulse', '-ar', String(sampleRate || 44100), '-ac', String(capCh), '-thread_queue_size', '512',
        '-i', pulseSource(cam.audioDeviceName, cam.audioDevice), '-map', '0:v', '-map', '1:a');
    }
    ffArgs.push('-af', `asetpts=PTS-STARTPTS,pan=stereo|c0=c${cL}|c1=c${cR},volume=${vol}`,
      '-vf', `setpts=PTS-STARTPTS,format=yuv420p,scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-r', String(fps),
      '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2', '-movflags', '+faststart', '-y', recOutPath);
    try {
      recFfmpegProc = spawn(ffmpeg, ffArgs, { stdio: ['pipe', 'ignore', 'pipe'] });
      let errOut = '';
      recFfmpegProc.stderr.on('data', d => { errOut = (errOut + d).slice(-4000); });
      recFfmpegProc.on('close', (code) => {
        recFfmpegProc = null;
        if (code === 0 || code === 255) safeSend(mainWindow.webContents, 'recording-stopped', { path: recOutPath });
        else safeSend(mainWindow.webContents, 'recording-stopped', { error: 'Camera recording failed: ' + errOut.split('\n').filter(l => l.trim()).slice(-2).join(' | ') });
        recOutPath = null;
      });
      recFfmpegProc.on('error', (err) => { recFfmpegProc = null; recOutPath = null; safeSend(mainWindow.webContents, 'recording-stopped', { error: err.message }); });
      recWriteStream = true;
      safeSend(mainWindow.webContents, 'recording-log', { msg: '● MP4 recording (camera)…' });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  if (recMode === 'pcm') {
    // Live mode (1.5.0): the meter tap's 16-bit PCM (attachMeterTap) → ffmpeg → output file
    const ffmpeg = findFFmpeg();
    const ffArgs = [
      '-f', 's16le', '-ar', String(recSampleRate), '-ac', '2', '-i', 'pipe:0',
    ];
    if (recFormat2 === 'wav') {
      ffArgs.push('-c:a', 'pcm_s16le', '-ar', '44100', '-ac', '2');
    } else {
      ffArgs.push('-c:a', 'aac', '-b:a', '320k', '-ar', '44100', '-ac', '2');
    }
    ffArgs.push('-y', recOutPath);
    try {
      recFfmpegProc = spawn(ffmpeg, ffArgs, { stdio: ['pipe', 'ignore', 'pipe'] });
      let errOut = '';
      recFfmpegProc.stderr.on('data', d => { errOut += d.toString(); });
      recFfmpegProc.on('close', (code) => {
        recFfmpegProc = null;
        if (code === 0) {
          safeSend(mainWindow.webContents, 'recording-stopped', { path: recOutPath });
        } else {
          const errLine = errOut.split('\n').filter(l=>l.trim()).slice(-3).join(' | ');
          safeSend(mainWindow.webContents, 'recording-stopped', { error: 'Recording failed: ' + errLine });
        }
        recOutPath = null;
      });
      recFfmpegProc.on('error', (err) => {
        recFfmpegProc = null; recOutPath = null;
        safeSend(mainWindow.webContents, 'recording-stopped', { error: err.message });
      });
      recWriteStream = true;
      safeSend(mainWindow.webContents, 'recording-log', { msg: `● ${ext.toUpperCase()} recording…` });
      return { ok: true };
    } catch(e) {
      return { ok: false, error: e.message };
    }
  } else {
    // Not live: receive webm chunks from MediaRecorder, convert at end
    recTmpPath = path.join(folder, `grooveline-rec-${timestamp}.webm`);
    try {
      fs.writeFileSync(recTmpPath, Buffer.alloc(0));
      recWriteStream = true;
      safeSend(mainWindow.webContents, 'recording-log', { msg: `● ${ext.toUpperCase()} recording…` });
      return { ok: true };
    } catch(e) {
      return { ok: false, error: e.message };
    }
  }
});

// Renderer streams webm chunks here during recording (not-live mode)
ipcMain.on('rec-chunk', (_, chunk) => {
  if (recTmpPath) {
    try { fs.appendFileSync(recTmpPath, Buffer.from(chunk)); } catch {}
  }
});

// Renderer calls this when done
ipcMain.handle('stop-recording', () => {
  if (!recWriteStream) return { ok: true };

  if (recFfmpegProc) {
    recWriteStream = null;
    if (recMode === 'pcm') {
      // Close stdin — ffmpeg finalizes and fires 'close'
      try { recFfmpegProc.stdin.end(); } catch {}
    } else if (recMode === 'cam') {
      // 'q' finishes the MP4 on every OS (a signal on Windows kills ffmpeg before it writes the index).
      const proc = recFfmpegProc;
      try { proc.stdin.write('q'); } catch {}
      setTimeout(() => { if (proc.exitCode === null && proc.signalCode === null) { try { proc.kill('SIGINT'); } catch {} } }, 5000);
    } else {
      // avfoundation mode — send SIGINT for clean file finalization
      try { recFfmpegProc.kill('SIGINT'); } catch {}
    }
    return { ok: true };
  }

  // webm mode
  const tmpPath = recTmpPath;
  const outPath = recOutPath;
  const fmt = recFormat2;
  recWriteStream = null; recTmpPath = null; recOutPath = null;

  (() => {
    let size = 0;
    try { size = fs.statSync(tmpPath).size; } catch {}
    if (size < 100) {
      try { fs.unlinkSync(tmpPath); } catch {}
      safeSend(mainWindow.webContents, 'recording-stopped', { error: 'No audio captured. Make sure Preview is running.' });
      return;
    }
    const ffmpeg = findFFmpeg();
    const ffArgs = ['-y', '-i', tmpPath];
    if (fmt === 'wav') {
      ffArgs.push('-c:a', 'pcm_s16le', '-ar', '44100', '-ac', '2');
    } else {
      ffArgs.push('-c:a', 'aac', '-b:a', '320k', '-ar', '44100', '-ac', '2');
    }
    ffArgs.push(outPath);
    safeSend(mainWindow.webContents, 'recording-log', { msg: 'Converting…' });
    const ffProc = spawn(ffmpeg, ffArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
    let errOut = '';
    ffProc.stderr.on('data', d => { errOut += d.toString(); });
    ffProc.on('close', (code) => {
      try { fs.unlinkSync(tmpPath); } catch {}
      if (code === 0) {
        safeSend(mainWindow.webContents, 'recording-stopped', { path: outPath });
      } else {
        const errLine = errOut.split('\n').filter(l=>l.trim()).slice(-3).join(' | ');
        safeSend(mainWindow.webContents, 'recording-log', { msg: `[ff] ${errLine}` });
        safeSend(mainWindow.webContents, 'recording-stopped', { error: 'Conversion failed' });
      }
    });
    ffProc.on('error', (err) => {
      try { fs.unlinkSync(tmpPath); } catch {}
      safeSend(mainWindow.webContents, 'recording-stopped', { error: err.message });
    });
  })();
  return { ok: true };
});

ipcMain.on('pcm-chunk', (_, buffer) => {
  try {
    const buf = buffer instanceof Buffer ? buffer : Buffer.from(buffer);
    // (Live recording is fed by the meter tap since 1.5.0, not by these float chunks.)
    pcmProcesses.forEach(proc => {
      try { if (proc.stdin && !proc.stdin.destroyed) proc.stdin.write(buf); } catch {}
    });
  } catch(e) {
    console.error('PCM chunk error:', e.message);
  }
});


ipcMain.handle('show-in-folder', (_, filePath) => {
  require('electron').shell.showItemInFolder(filePath);
});

// ─── Now Playing ──────────────────────────────────────────────────────────────
let npWatcher = null;
let npPollInterval = null;
let npOverlayServer = null;
let npCurrentTrack = { artist: '', title: '' };

// Auto-find the Now Playing app's output folder and latest file
function findNowPlayingFile() {
  const dir = path.join(os.homedir(), '.nowplaying');
  return findLatestFileInDir(dir, ['.txt']);
}

// Expand leading ~ to home directory (Node fs doesn't do this automatically)
function expandPath(p) {
  if (!p) return p;
  if (p.startsWith('~/') || p === '~') return path.join(os.homedir(), p.slice(1));
  return p;
}

// Auto-detect latest file in a directory matching a pattern (for dated files like 2026-03-12.txt)
function findLatestFileInDir(dirPath, extensions) {
  try {
    if (!fs.existsSync(dirPath)) return null;
    const exts = extensions || ['.txt', '.log'];
    const files = fs.readdirSync(dirPath)
      .filter(f => exts.some(e => f.toLowerCase().endsWith(e)))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(dirPath, f)).mtime }))
      .sort((a, b) => b.mtime - a.mtime);
    return files.length ? path.join(dirPath, files[0].name) : null;
  } catch { return null; }
}

function findLatestTraktorHistory() {
  const base = path.join(os.homedir(), 'Documents', 'Native Instruments', 'Traktor');
  try {
    const files = fs.readdirSync(base)
      .filter(f => f.toLowerCase().startsWith('history') && f.toLowerCase().endsWith('.nml'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(base, f)).mtime }))
      .sort((a, b) => b.mtime - a.mtime);
    return files.length ? path.join(base, files[0].name) : null;
  } catch { return null; }
}

function parseTrackLine(line, software) {
  line = line.trim();
  if (!line) return null;
  if (software === 'traktor') {
    const titleMatch = line.match(/TITLE="([^"]+)"/);
    const artistMatch = line.match(/ARTIST="([^"]+)"/);
    if (titleMatch) return { title: titleMatch[1], artist: artistMatch ? artistMatch[1] : '' };
    return null;
  }
  // Now Playing app format: "2026-03-12 07:14.33 pm: Artist - Title - [Label]"
  // Strip timestamp (12h or 24h)
  line = line.replace(/^\d{4}-\d{2}-\d{2}\s+\d+:\d+[\d.:]*\s*(?:[ap]m)?:\s*/i, '');
  // Strip trailing ' - [anything]' — the label section (may be empty '[]')
  line = line.replace(/\s*-\s*\[[^\]]*\]\s*$/, '').trim();
  // Now have: 'Artist - Title'  or just  'Title' (no artist)
  if (line.includes(' - ')) {
    const idx = line.indexOf(' - ');
    const artist = line.slice(0, idx).trim();
    const title  = line.slice(idx + 3).trim();
    if (!artist && !title) return null;
    return { artist, title: title || artist };
  }
  if (!line) return null;
  return { artist: '', title: line };
}

function readNpFile(filePath, software) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lastLine = content.split('\n').filter(l=>l.trim()).slice(-1)[0];
    console.log('[NP] readNpFile software=' + software + ' bytes=' + content.length + ' lastLine=' + JSON.stringify(lastLine));
    if (software === 'traktor') {      // Traktor NML: find the last ENTRY element that has a TITLE attribute
      // Could be on multiple lines — join and search
      const allEntries = [];
      const entryRegex = /<ENTRY\b([^>]*)>/gi;
      let match;
      while ((match = entryRegex.exec(content)) !== null) {
        const attrs = match[1];
        const titleMatch = attrs.match(/TITLE="([^"]+)"/);
        const artistMatch = attrs.match(/ARTIST="([^"]+)"/);
        if (titleMatch) {
          allEntries.push({ title: titleMatch[1], artist: artistMatch ? artistMatch[1] : '' });
        }
      }
      // Also handle multi-line entries where TITLE might be on next line
      if (allEntries.length === 0) {
        const lines = content.split('\n');
        for (const line of lines) {
          const t = parseTrackLine(line, 'traktor');
          if (t) allEntries.push(t);
        }
      }
      return allEntries.length ? allEntries[allEntries.length - 1] : null;
    }
    const lines = content.split('\n').filter(l => l.trim());
    if (!lines.length) return null;
    return parseTrackLine(lines[lines.length - 1], software);
  } catch { return null; }
}

ipcMain.handle('open-file-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    title: 'Select Now Playing File',
    filters: [{ name: 'Text/NML files', extensions: ['txt', 'nml', 'xml', '*'] }]
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('start-np-watcher', async (event, { filePath, software, overlay }) => {
  if (npWatcher) { try { npWatcher.close(); } catch {} npWatcher = null; }
  if (npPollInterval) { clearInterval(npPollInterval); npPollInterval = null; }

  // Auto-detect latest Traktor history file
  let resolvedPath = expandPath(filePath);
  if (software === 'traktor') {
    const latest = findLatestTraktorHistory();
    if (latest) {
      resolvedPath = latest;
      try { safeSend(mainWindow.webContents, 'np-log', { msg: 'Auto-detected: ' + path.basename(latest) }); } catch {}
    } else if (!filePath || !fs.existsSync(filePath)) {
      return { ok: false, error: 'No Traktor history file found. Play a track in Traktor first.' };
    }
  }

  // For non-Traktor sources, ALWAYS pick the most recently modified file in the dir.
  // Now Playing app writes dated files (2026-03-12.txt) — the user's saved path
  // may be yesterday's file. Always resolve to latest.
  if (software !== 'traktor') {
    const dir = path.dirname(resolvedPath);
    const ext = path.extname(resolvedPath) || '.txt';
    const dirExists = fs.existsSync(dir);
    if (dirExists) {
      const latest = findLatestFileInDir(dir, [ext]);
      if (latest) {
        if (latest !== resolvedPath) {
          try { safeSend(mainWindow.webContents, 'np-log', { msg: 'Latest file: ' + path.basename(latest) }); } catch {}
        }
        resolvedPath = latest;
      }
    }
    if (!fs.existsSync(resolvedPath)) {
      return { ok: false, error: 'File not found. Dir exists: ' + dirExists + ' — ' + resolvedPath };
    }
  } else if (!fs.existsSync(resolvedPath)) {
    return { ok: false, error: 'File not found: ' + resolvedPath };
  }
  // Log resolved path to UI
  try { safeSend(mainWindow.webContents, 'np-log', { msg: 'Watching: ' + path.basename(resolvedPath) }); } catch {}

  if (overlay && !npOverlayServer) {
    const http = require('http');
    npOverlayServer = http.createServer((req, res) => {
      if (req.url === '/nowplaying.json') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(npCurrentTrack));
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:transparent; font-family:'Inter',sans-serif; padding:12px 16px; }
  .np { display:inline-flex; flex-direction:column; background:rgba(0,0,0,0.75);
        border-left:3px solid #ff6b00; border-radius:4px; padding:8px 14px; max-width:420px; }
  .artist { font-size:11px; color:#ff6b00; font-weight:700; letter-spacing:1px; text-transform:uppercase; }
  .title  { font-size:15px; color:#fff; font-weight:600; margin-top:2px; }
  .label  { font-size:9px; color:#888; margin-top:3px; letter-spacing:1px; text-transform:uppercase; }
</style>
<script>
  async function poll() {
    try {
      const d = await fetch('/nowplaying.json').then(r=>r.json());
      document.getElementById('a').textContent = d.artist || '';
      document.getElementById('t').textContent = d.title || 'No track playing';
    } catch {}
    setTimeout(poll, 2000);
  }
  poll();
</script>
</head><body>
<div class="np">
  <div class="artist" id="a"></div>
  <div class="title"  id="t">Loading...</div>
  <div class="label">GROOVELINE RADIO</div>
</div>
</body></html>`);
      }
    });
    npOverlayServer.listen(4242, '127.0.0.1');
  } else if (!overlay && npOverlayServer) {
    npOverlayServer.close(); npOverlayServer = null;
  }

  const initial = readNpFile(resolvedPath, software);
  const fileSize = (() => { try { return fs.statSync(resolvedPath).size + 'b'; } catch { return '?'; } })();
  // Show last line of file so format issues are visible in the log
  try {
    const rawContent = fs.readFileSync(resolvedPath, 'utf8');
    const lastLine = rawContent.split('\n').filter(l => l.trim()).slice(-1)[0] || '(empty file)';
    safeSend(mainWindow.webContents, 'np-log', { msg: `File: ${path.basename(resolvedPath)} (${fileSize})` });
    safeSend(mainWindow.webContents, 'np-log', { msg: `Last line: ${lastLine.slice(0, 80)}` });
  } catch {}
  safeSend(mainWindow.webContents, 'np-log', { msg: `Parsed: ${JSON.stringify(initial)}` });
  // Reset and store initial track
  npCurrentTrack = initial || { artist: '', title: '' };

  const checkTrack = () => {
    let checkPath = resolvedPath;
    if (software === 'traktor') {
      const latest = findLatestTraktorHistory();
      if (latest) checkPath = latest;
    } else if (!fs.existsSync(checkPath)) {
      // File may have rolled to a new dated filename (e.g. midnight rollover)
      const dir = path.dirname(checkPath);
      const ext = path.extname(checkPath);
      const latest = findLatestFileInDir(dir, [ext || '.txt']);
      if (latest) { resolvedPath = latest; checkPath = latest; }
    }
    const track = readNpFile(checkPath, software);
    if (track) {
      const newKey = (track.artist + '|' + track.title).toLowerCase();
      const oldKey = (npCurrentTrack.artist + '|' + npCurrentTrack.title).toLowerCase();
      if (newKey !== oldKey) {
        npCurrentTrack = track;
        console.log('[NP] Track changed:', JSON.stringify(track));
        safeSend(mainWindow.webContents, 'np-track', track);
      }
    }
  };

  npPollInterval = setInterval(checkTrack, 3000);
  // Watch the directory so we catch new dated files (e.g. midnight rollover)
  // Fall back to watching the file directly if dir watch fails
  try {
    const watchTarget = software !== 'traktor' ? path.dirname(resolvedPath) : resolvedPath;
    npWatcher = fs.watch(watchTarget, () => checkTrack());
  } catch { try { npWatcher = fs.watch(resolvedPath, () => checkTrack()); } catch {} }

  return { ok: true, resolvedPath, initialTrack: npCurrentTrack };
});

ipcMain.handle('get-np-current', () => {
  return npCurrentTrack;
});

ipcMain.handle('stop-np-watcher', () => {
  if (npWatcher) { try { npWatcher.close(); } catch {} npWatcher = null; }
  if (npPollInterval) { clearInterval(npPollInterval); npPollInterval = null; }
  if (npOverlayServer) { npOverlayServer.close(); npOverlayServer = null; }
  npCurrentTrack = { artist: '', title: '' }; // reset so next start always fires initial track
  return { ok: true };
});


ipcMain.handle('update-icecast-meta', async (_, { url, mount, user, pass, track }) => {
  // Send metadata update to Icecast /admin/metadata
  try {
    const http = url.startsWith('https') ? require('https') : require('http');
    const parsed = new URL(url);
    const song = encodeURIComponent(`${track.artist ? track.artist + ' - ' : ''}${track.title}`);
    const adminUrl = `${parsed.protocol}//${parsed.host}/admin/metadata?mount=${encodeURIComponent(mount)}&mode=updinfo&song=${song}`;
    const auth = Buffer.from(`${user}:${pass}`).toString('base64');
    return new Promise((resolve) => {
      const req = http.get(adminUrl, { headers: { 'Authorization': `Basic ${auth}` } }, (res) => {
        resolve({ ok: res.statusCode === 200, status: res.statusCode });
      });
      req.on('error', e => resolve({ ok: false, error: e.message }));
      req.setTimeout(3000, () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    });
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('get-home-dir', () => {
  const os = require('os');
  return os.homedir();
});

ipcMain.handle('force-quit', async () => {
  stopAllStreams();
  await releaseDevices(); // also waits for the SIGTERM'd ffmpeg to let go of the camera
  app.exit(0);
});

ipcMain.handle('minimize-window', () => mainWindow?.minimize());
ipcMain.handle('maximize-window', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.handle('close-window', () => mainWindow?.close());

ipcMain.handle('open-external', (_, url) => {
  require('electron').shell.openExternal(url);
});

// ─── App info, log file, changelog, update check (1.5.0) ──────────────────────
function toolVersion(cmd, args) {
  return new Promise(resolve => {
    let out = '';
    try {
      const p = spawn(cmd, args);
      p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; });
      p.on('close', () => resolve(out.split('\n').find(l => l.trim()) || null));
      p.on('error', () => resolve(null));
      setTimeout(() => { try { p.kill(); } catch {} }, 4000);
    } catch { resolve(null); }
  });
}

ipcMain.handle('get-app-info', async () => {
  const b = buildInfo();
  const ffmpeg = await toolVersion(findFFmpeg(), ['-version']);
  const sox = process.platform === 'darwin' ? await toolVersion(findSox(), ['--version']) : null;
  return {
    ...b, line: buildLine(), os: OS_NAME, platform: process.platform, osRelease: os.release(), arch: process.arch,
    electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node,
    ffmpeg: ffmpeg ? ffmpeg.replace(/ Copyright.*$/, '') : null, ffmpegBundled: findFFmpeg() !== 'ffmpeg' && findFFmpeg() !== 'ffmpeg.exe',
    sox: sox ? sox.replace(/^.*SoX v/, 'SoX v') : null, logsDir: logsDir(),
  };
});

ipcMain.on('log-write', (_, { type, msg, tech }) => writeLog(type, msg, tech));

ipcMain.handle('log-save', async () => {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const r = await dialog.showSaveDialog(mainWindow, { title: 'Save log', defaultPath: path.join(app.getPath('documents'), `grooveline-broadcaster-${stamp}.log`) });
  if (r.canceled || !r.filePath) return { ok: false };
  try {
    // This session first, then the one before (a crash or a restart often matters).
    const prev = path.join(logsDir(), 'broadcaster.1.log');
    let text = logFile && fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    if (fs.existsSync(prev)) text += '\n── previous session ──\n' + fs.readFileSync(prev, 'utf8');
    fs.writeFileSync(r.filePath, maskSecrets(text));
    return { ok: true, path: r.filePath };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('log-open-folder', () => require('electron').shell.openPath(logsDir()));

// CHANGELOG.md ships inside the app; the renderer shows its own version's section as "What's new".
ipcMain.handle('get-changelog', () => {
  try { return fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8'); } catch { return ''; }
});

// Update check: https://downloads.grooveline.org/latest.json, e.g.
//   { "latest": { "linux": "1.5.0", "win32": "1.3.0", "darwin": "1.0.6" }, "url": "https://grooveline.org/broadcast" }
// or { "version": "1.5.0", "url": … } for all systems. Missing file or no network → { ok: false }, the app says nothing.
const newerThan = (a, b) => {
  const pa = String(a).split(/[.-]/).map(n => parseInt(n) || 0), pb = String(b).split(/[.-]/).map(n => parseInt(n) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
};
ipcMain.handle('check-update', () => new Promise(resolve => {
  const https = require('https');
  const req = https.get('https://downloads.grooveline.org/latest.json', { timeout: 6000, headers: { 'User-Agent': `GroovelineBroadcaster/${app.getVersion()}` } }, res => {
    if (res.statusCode !== 200) { res.resume(); return resolve({ ok: false, status: res.statusCode }); }
    let body = '';
    res.setEncoding('utf8');
    res.on('data', d => { body += d; if (body.length > 1e5) req.destroy(); });
    res.on('end', () => {
      try {
        const j = JSON.parse(body);
        const latest = (j.latest && j.latest[process.platform]) || j.version;
        if (!latest) return resolve({ ok: false });
        resolve({ ok: true, latest: String(latest), current: app.getVersion(), newer: newerThan(latest, app.getVersion()),
          url: /^https:\/\//.test(j.url || '') ? j.url : 'https://grooveline.org/broadcast' });
      } catch { resolve({ ok: false }); }
    });
  });
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.on('error', () => resolve({ ok: false }));
}));

// ─── Grooveline API proxy (renderer fetch is blocked by Electron security) ───
function apiRequest(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const url = new URL('https://api.grooveline.org' + path);
    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json' }
    };
    if (token) options.headers['Authorization'] = `Bearer ${token}`;
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        // `date` is the server's clock: GO LIVE opens by slot time, and a DJ's laptop can be minutes off (1.6.0).
        try { resolve({ status: res.statusCode, body: JSON.parse(data), date: res.headers.date || null }); }
        catch(e) { resolve({ status: res.statusCode, body: { error: data }, date: res.headers.date || null }); }
      });
    });
    req.on('error', (e) => reject(e));
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timed out')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

ipcMain.handle('api-ping', async () => {
  return { ok: true, time: Date.now() };
});

ipcMain.handle('api-login', async (_, { email, password }) => {
  return apiRequest('POST', '/auth/login', { email, password }, null);
});

ipcMain.handle('api-me', async (_, { token }) => {
  return apiRequest('GET', '/auth/me', null, token);
});

ipcMain.handle('api-bookings', async (_, { token }) => {
  return apiRequest('GET', '/bookings', null, token);
});

ipcMain.handle('api-credentials', async (_, { token, bookingId }) => {
  return apiRequest('GET', `/credentials/${bookingId}`, null, token);
});

// Sound check (1.3.0): the DJ's private /check-* mount, created on first use,
// and whether OUR Icecast is receiving it — same endpoints as the website.
ipcMain.handle('api-check-mount', async (_, { token }) => {
  return apiRequest('GET', '/check/mount', null, token);
});

ipcMain.handle('api-check-status', async (_, { token }) => {
  return apiRequest('GET', '/check/status', null, token);
});

ipcMain.handle('check-ffmpeg', async () => {
  return new Promise((resolve) => {
    const ffmpeg = findFFmpeg();
    const proc = spawn(ffmpeg, ['-version']);
    let out = '';
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', d => out += d);
    proc.on('close', code => resolve({ found: code === 0, version: out.split('\n')[0] }));
    proc.on('error', () => resolve({ found: false, version: null }));
  });
});

ipcMain.handle('open-ffmpeg-help', () => {
  const urls = {
    darwin: 'https://formulae.brew.sh/formula/ffmpeg',
    win32: 'https://ffmpeg.org/download.html#build-windows',
    linux: 'https://ffmpeg.org/download.html#build-linux'
  };
  require('electron').shell.openExternal(urls[process.platform] || 'https://ffmpeg.org/download.html');
});

// Lists DirectShow devices. ffmpeg ≥5 prints `"Name" (audio)` / `(video)` per
// device and no longer prints the "DirectShow audio devices" section headers the
// old parser waited for — with the bundled ffmpeg 9 it found ZERO devices, so the
// stream fell back to `audio=default`, which does not exist on Windows (20 Oct
// 2026: every Windows GO LIVE failed with "Error opening input file
// audio=default"). Both formats are parsed here.
function parseDshowList(stderr) {
  const devices = [], videoDevices = [];
  let section = null, aIdx = 0, vIdx = 0;
  for (const line of stderr.split(/\r?\n/)) {
    if (line.includes('DirectShow video devices')) { section = 'video'; continue; }
    if (line.includes('DirectShow audio devices')) { section = 'audio'; continue; }
    if (line.includes('Alternative name')) continue;
    const m = line.match(/"([^"]+)"(?:\s*\(([^)]*)\))?/);
    if (!m) continue;
    const kinds = m[2] ? m[2].split(',').map(k => k.trim()) : [section];
    const name = m[1].trim();
    if (kinds.includes('video')) videoDevices.push({ index: vIdx++, name });
    if (kinds.includes('audio')) devices.push({ index: aIdx++, name });
  }
  return { devices, videoDevices };
}
function listDshowDevices() {
  return new Promise((resolve) => {
    const proc = spawn(findFFmpeg(), ['-hide_banner', '-f', 'dshow', '-list_devices', 'true', '-i', 'dummy']);
    let stderr = '', done = false;
    const finish = (extra) => { if (done) return; done = true; try { proc.kill(); } catch {} resolve({ ...parseDshowList(stderr), raw: stderr, ...extra }); };
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', () => finish());
    proc.on('error', (e) => finish({ error: e.message }));
    setTimeout(() => finish(), 10000);
  });
}

// Linux cameras straight from sysfs (no v4l-utils needed). Every V4L2 camera, built-in
// (e.g. the MacBook FaceTime HD via facetimehd) or USB/UVC, shows up here. A UVC camera
// registers two nodes, capture (index 0) plus metadata (index 1), so only index 0 is kept.
function listV4l2Devices() {
  const base = '/sys/class/video4linux';
  const out = [];
  try {
    const nodes = fs.readdirSync(base).filter(n => /^video\d+$/.test(n))
      .sort((a, b) => parseInt(a.slice(5)) - parseInt(b.slice(5)));
    for (const n of nodes) {
      let name = n, idx = '0';
      try { name = fs.readFileSync(`${base}/${n}/name`, 'utf8').trim() || n; } catch {}
      try { idx = fs.readFileSync(`${base}/${n}/index`, 'utf8').trim(); } catch {}
      if (idx !== '0') continue;
      out.push({ index: `/dev/${n}`, path: `/dev/${n}`, name });
    }
  } catch {}
  return out;
}

ipcMain.handle('list-audio-devices', async () => {
  const platform = process.platform;

  // ── macOS: AVFoundation ──────────────────────────────────────────────────────
  if (platform === 'darwin') {
    return new Promise((resolve) => {
      const ffmpeg = findFFmpeg();
      const proc = spawn(ffmpeg, ['-f', 'avfoundation', '-list_devices', 'true', '-i', '""']);
      let stderr = '';
      proc.stderr.on('data', d => { stderr += d.toString(); });
      proc.on('close', () => {
        const devices = [], videoDevices = [];
        const lines = stderr.split('\n');
        let inAudio = false, inVideo = false;
        for (const line of lines) {
          if (line.includes('AVFoundation video devices')) { inVideo = true; inAudio = false; continue; }
          if (line.includes('AVFoundation audio devices')) { inAudio = true; inVideo = false; continue; }
          const m = line.match(/\[(\d+)\]\s+(.+)/);
          if (m) {
            if (inAudio) devices.push({ index: parseInt(m[1]), name: m[2].trim() });
            if (inVideo) videoDevices.push({ index: parseInt(m[1]), name: m[2].trim() });
          }
        }
        resolve({ devices, videoDevices, raw: stderr });
      });
      proc.on('error', (e) => resolve({ devices: [], error: e.message }));
      setTimeout(() => { try { proc.kill(); } catch {} }, 4000);
    });
  }

  // ── Windows: DirectShow ───────────────────────────────────────────────────────
  if (platform === 'win32') return listDshowDevices();

  // ── Linux: PipeWire/PulseAudio ───────────────────────────────────────────────
  // `pactl list sources` (LC_ALL=C: the field names are translated otherwise) gives each source's name, which is
  // what ffmpeg -f pulse needs, and its description, which is the label Chromium shows. Monitors ("Monitor of …")
  // capture what an output plays.
  return new Promise((resolve) => {
    const proc = spawn('pactl', ['list', 'sources'], { env: { ...process.env, LC_ALL: 'C' } });
    let stdout = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.on('close', () => {
      // "Default Source:" names what the "Default input" option streams.
      const info = spawn('pactl', ['info'], { env: { ...process.env, LC_ALL: 'C' } });
      let txt = '';
      info.stdout.on('data', d => { txt += d; });
      const done = () => resolve({ devices: parsePactlSources(stdout), videoDevices: listV4l2Devices(), defaultName: ((txt.match(/^Default Source:\s*(.+)$/m) || [])[1] || '').trim() });
      info.on('close', done); info.on('error', done);
    });
    proc.on('error', () => resolve({ devices: [{ index: 0, name: 'default', description: 'Default input' }], videoDevices: listV4l2Devices() }));
  });
});

function parsePactlSources(text) {
  return text.split(/^Source #/m).slice(1).map((block, i) => {
    const get = re => (block.match(re) || [])[1];
    const spec = get(/^\s*Sample Specification:\s*(.+)$/m) || '';
    return {
      index: i,
      name: (get(/^\s*Name:\s*(.+)$/m) || '').trim(),
      description: (get(/^\s*Description:\s*(.+)$/m) || '').trim(),
      channels: parseInt((spec.match(/(\d+)ch/) || [])[1]) || 2,
      rate: parseInt((spec.match(/(\d+)Hz/) || [])[1]) || 48000,
      monitor: (get(/^\s*Monitor of Sink:\s*(\S+)/m) || 'n/a') !== 'n/a',
    };
  }).filter(d => d.name);
}

// Raw file read for diagnostics — shows exact bytes in the file
ipcMain.handle('read-np-file-raw', async (_, filePath) => {
  try {
    const resolved = expandPath(filePath);
    // If exact path doesn't exist, find latest in dir
    let finalPath = resolved;
    if (!fs.existsSync(finalPath)) {
      const dir = path.dirname(finalPath);
      const ext = path.extname(finalPath) || '.txt';
      const latest = findLatestFileInDir(dir, [ext]);
      if (latest) finalPath = latest;
    }
    if (!fs.existsSync(finalPath)) return { ok: false, error: 'File not found: ' + finalPath };
    const raw = fs.readFileSync(finalPath, 'utf8');
    const lines = raw.split('\n').filter(l => l.trim());
    return {
      ok: true,
      path: finalPath,
      size: raw.length,
      lineCount: lines.length,
      lastLine: lines[lines.length - 1] || '',
      allLines: lines.slice(-5),  // last 5 lines
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Return the auto-detected Now Playing app file path (for UI pre-fill)
ipcMain.handle('detect-nowplaying-path', async () => {
  const file = findNowPlayingFile();
  const dir = path.join(os.homedir(), '.nowplaying');
  return {
    file: file || null,
    dir: dir,
    dirExists: fs.existsSync(dir),
  };
});

ipcMain.handle('probe-audio-channels', async (_, { deviceIndex, deviceName }) => {
  return new Promise((resolve) => {
    const ffmpeg = findFFmpeg();
    const platform = process.platform;

    // Build platform-specific probe args
    let probeArgs;
    if (platform === 'darwin') {
      probeArgs = ['-f', 'avfoundation', '-i', `:${deviceIndex}`];
    } else if (platform === 'win32') {
      probeArgs = ['-f', 'dshow', '-i', `audio=${deviceName}`];
    } else {
      // Linux: try PulseAudio first, ALSA fallback handled by device name convention
      probeArgs = ['-f', 'pulse', '-i', deviceName || 'default'];
    }

    const proc = spawn(ffmpeg, [...probeArgs, '-t', '0.1', '-f', 'null', '-']);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', () => {
      let channels = 2;
      const layoutMap = {
        'mono': 1, 'stereo': 2,
        '2.1': 3, '3.0': 3, 'triangle': 3,
        'quad': 4, '4.0': 4, '3.1': 4,
        '5.0': 5, '4.1': 5,
        '5.1': 6, '6.0': 6,
        '6.1': 7, '7.0': 7,
        '7.1': 8, 'octagonal': 8,
      };
      const numMatch = stderr.match(/Audio:.*?,\s*(\d+)\s+channels/i)
                    || stderr.match(/(\d+)\s+channels/i);
      if (numMatch) {
        channels = parseInt(numMatch[1]);
      } else {
        for (const [layout, count] of Object.entries(layoutMap)) {
          if (stderr.includes(`, ${layout},`) || stderr.includes(` ${layout} `)) {
            channels = count;
            break;
          }
        }
      }
      let nativeSampleRate = 44100;
      const srMatch = stderr.match(/Audio:[^,]+,\s*(\d+)\s+Hz/i);
      if (srMatch) nativeSampleRate = parseInt(srMatch[1]);
      setTimeout(() => resolve({ channels, nativeSampleRate, deviceName, stderr: stderr.slice(-800) }), 800);
    });
    proc.on('error', () => setTimeout(() => resolve({ channels: 2 }), 800));
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5000);
  });
});