# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repo, CI and releases (since 21 Oct 2026)

- **Public repo** `nexlineai/grooveline-broadcaster` (MIT). Before 21 Oct the code lived in the private
  `grooveline-platform/broadcaster`; that copy is frozen. It is public because, on GitHub's plans, only public repos get
  the environment approval gate and free macOS runners.
- **Never commit secrets.** Signing secrets live only in the `mac-release` environment (maintainer approval, `v*` tags).
  No repo-level secrets, ever. Never use `pull_request_target`.
- `.github/workflows/build.yml`: unsigned Windows, Linux and macOS builds on every push, plus `scripts/mac-smoke.sh`.
- `.github/workflows/release-mac.yml`: runs on a `v*` tag. Its `sign` job (environment `mac-release`) uses
  `scripts/mac-ci-keychain.sh` to build a throwaway keychain, then `scripts/mac-sign-notarize.sh`, which the stick kit
  shares. Its `publish` job attaches the dmgs to a **prerelease**; the download page is changed by hand after testing.
- `--mac dmg` on the CLI builds **only the host arch** unless you pass `--arm64 --x64`. The first CI run made only the
  arm64 dmg because of this.
- `scripts/mac-deps.sh` fetches the pinned, checksummed `bin/mac` ffmpeg and sox (`bin/` is gitignored).

## Commands

```bash
npm start                    # Run in dev mode
npm run dev                  # Run with DevTools open
npm run dist:mac             # Build macOS DMG (universal arm64+x64)
npm run build:win            # Build Windows NSIS installer (run as Administrator)
npm run build:linux          # Build Linux AppImage/.deb
scripts/mac-deps.sh          # Fetch the pinned ffmpeg+sox for macOS into bin/mac/
npm run prepare-binaries-win # Download ffmpeg.exe for Windows bin/win/
```

## Architecture

Three files, all in `src/`:

- **`main.js`** — Electron main process. All IPC handlers, ffmpeg/sox child process spawning, device enumeration, config persistence (`app.getPath('userData')/config.json`), tray icon, window management.
- **`index.html`** — Single-file renderer: all UI, CSS, and JS inline. No separate JS files (Cloudflare Pages constraint carried over). Calls everything via `window.grooveline.*`.
- **`preload.js`** — contextBridge that exposes IPC as `window.grooveline`. `contextIsolation: true`, `nodeIntegration: false`.

### Streaming architecture

**macOS** uses two separate processes to avoid Chromium's camera lock on AVFoundation:
1. **Icecast/audio-only:** `sox` (CoreAudio) → raw PCM pipe → `ffmpeg` → Ogg/Vorbis → Icecast
2. **RTMP/video:** renderer canvas → `MediaRecorder` (vp8 webm chunks) → IPC `video-chunk` → ffmpeg stdin (pipe:0) as video; `sox` CoreAudio → PCM pipe fd3 as audio → ffmpeg → h264+aac → FLV → RTMP

**Windows/Linux** uses a single `ffmpeg` process via `buildTeeArgs()`:
- Windows: DirectShow (`-f dshow`) for both audio and video
- Linux: v4l2 + PulseAudio

### Platform branching

All platform differences are inside `buildTeeArgs()` and `startSoxStream()`/`startVideoStream()` in `main.js`. The renderer (`index.html`) calls `get-platform` at startup and branches where needed (e.g. canvas capture only on macOS).

### Live supervisor + failure reports (1.2.0, 20 Oct 2026)

GO LIVE opens a `liveSession` in `main.js` that lasts until STOP. Every spawned
process is tagged with the session generation (`tagProc`), every stderr line goes
through `superviseLine` (progress + error classification) and every `close`
handler calls `pipelineExited` first. On exit, **stall** (ffmpeg `time=` stops
advancing for 15 s) or a **failed server health check** the whole pipeline is
torn down and relaunched with backoff 2/4/8/15/30 s.
- **Server health check (`checkServerHealth`)**: every 5 s while live, read the
  Icecast `status-json.xsl` of the first Icecast profile. Unreachable 3× in a row,
  or no `stream_start` on our mount for 10 s → dead path → relaunch. ffmpeg's own
  progress is NOT enough: kernel socket buffers swallow minutes of quiet audio on
  a dead path, so the app kept saying LIVE after Icecast had dropped the source
  (found by the 20 Oct e2e). 404 on status-json → check disabled for the session.
- **403 "Mountpoint in use" = keep trying every 15 s**: after a drop, the dead
  connection holds the mount until Icecast's source-timeout (600 s on Grooveline).
- 401 / audio device / encoder: give up after 3 in a row (`stream-stopped` with a reason).
- The macOS canvas-video path is not supervised (webm can't restart mid-stream).
- Renderer shows `RECONNECTING (n) ↻ Xs` via `stream-reconnecting` / `stream-reconnected`.
- Reports to `POST /setup/report` (app_live, app_error, app_reconnecting,
  app_reconnected, app_gave_up) when the DJ is logged in (`_acctToken` in config).
- `maskSecrets()` in `safeSend` masks `icecast://user:<pw>@` and RTMP keys in
  everything sent to the log — never log a raw URL around it.

### In-app sound check (1.3.0, 20 Oct 2026)

**◎ SOUND CHECK** under GO LIVE opens `#check-modal`: sign in (reuses `acctLogin`)
→ START. `GET /check/mount` (IPC `api-check-mount`) gives the DJ's private
`/check-*` mount, the same one the website's sound check uses. The answer comes
from `GET /check/status` (our Icecast), polled every 3 s, never from ffmpeg.
- The check destination is a one-off override, `toggleLive(ev, checkProfile)`.
  It is **never saved into `cfg`**, and the DJ's own destinations are ignored for the run.
- `main.js` refuses `soundCheck: true` unless there is exactly one Icecast profile on
  `/^\/check-[a-z0-9-]+$/` (forced audio-only). This guard keeps a test off a public mount.
- Status reads `TESTING (private) ●`. `reportSetup` details are prefixed `sound check:`.
- LISTEN plays `https://<server>/<mount>` in the app. The hint says headphones only,
  and never with a virtual cable as the system output.
- 401 within `AUTH_GRACE_MS` retries every 5 s: a new mount needs the 1-min sync.
- 403 text now says how long the wait is: ~1 min on `/check-*`, up to 10 min elsewhere.
- Fixed: signing in after launch left `cfg` without `_acctToken`, so the next
  `saveCfg()` dropped the token.
- e2e: a Playwright `_electron` harness outside this repo (temp account, decoy destination).

### Device flow

1. `list-audio-devices` IPC → ffmpeg `-list_devices` (AVFoundation/dshow) or `pactl` (Linux) → returns `{ devices[], videoDevices[] }`
2. Renderer merges with `enumerateDevices()` results, tags each browser option with `data-ffmpeg-index` / `data-ffmpeg-name` / `data-av-index` / `data-ds-name`
3. `probe-audio-channels` IPC → 0.1s ffmpeg probe → returns `{ channels, nativeSampleRate }`
4. Channel picker built from channel count — sox always captures `max(cL,cR)+1` channels, ffmpeg `pan=` filter routes selected pair

### Binaries

- `bin/mac/` — `ffmpeg` and `sox` (populated by `prepare-binaries`)
- `bin/win/` — `ffmpeg.exe` (populated by `prepare-binaries-win`)
- Linux — system ffmpeg from PATH, no bundling
- `findFFmpeg()` checks `process.resourcesPath` first (production), then PATH (dev)

## Current Blocker — Video Streaming (2026-04-09)

**URGENT:** Video RTMP streaming crashes after 2-5 minutes with `[vost#0:0/libx264] Error submitting a packet to the muxer: End of file` → `Broken pipe`. Audio-only Icecast is **stable**. 

**Diagnosis:** Canvas→MediaRecorder→IPC pipeline is dying. Added debug logging:
- `index.html` line ~1376: MediaRecorder chunk counter, `onerror`, `onstop` handlers
- `main.js` line ~593: `videoChunkWatchdog` — monitors for 5+ second gaps in video chunks

**Next step:** Rebuild DMG (`npm run dist:mac`) and run 360p test with new debug logs. Logs will show exactly where pipeline breaks:
1. No `[video] chunks sent` messages → canvas draw loop dead
2. `[video] MediaRecorder error` → encoding failure  
3. `[video] No chunks for 5s` → IPC delivery stopped

See grooveline memory file for full context.

## Critical gotchas

- **`const https` / `const http` must never be top-level** in `main.js` — causes silent startup crash. Declare inline inside IPC handlers.
- **Never use ScriptProcessor** in renderer — crashes under IPC load. Use AudioWorklet.
- **`e.data.buffer` not `e.data`** when receiving Float32Array from AudioWorklet postMessage.
- **`use_wallclock_as_timestamps`** — destroys A/V sync via epoch timestamps (~1774361217s). Never use.
- **macOS:** `asetpts=PTS-STARTPTS` resets AVFoundation epoch timestamps but doesn't fix two-clock mux drift. Sox audio path is the only stable solution.
- **Windows RTMP:** DirectShow video timestamps start at ~500000s — must reset with `setpts=PTS-STARTPTS` in vf filter. Error `-10054` (WSAECONNRESET) means server rejected huge PTS values.
- **Mac signing (from 1.3.0, 21 Oct 2026):** Developer ID (Individual account) with hardened runtime on. One
  entitlements file, `build/entitlements.mac.plist`, covers the app and every binary inside it. It includes
  `device.audio-input`, which **sox needs too** (sox does the CoreAudio capture). The ad-hoc `afterSign.js` is gone.
  `mac.notarize: false`: notarization happens in `scripts/mac-release.sh`, which also signs `bin/mac/*`,
  verifies, staples and checks Gatekeeper.
  - The signed build runs in GitHub Actions. `scripts/mac-release.sh` (a USB-stick kit for the Monterey Air) is the
    fallback.
  - `bin/mac` ffmpeg (minos 10.12) and sox (minos 10.10) are x86_64-only and link only `/usr/lib` and `/System`.
    On Apple Silicon they need Rosetta.
- **Windows build must run as Administrator.**
