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
- The two dmgs build **in parallel**, and dmg-builder first unmounts any volume with its own name
  (`/Volumes/<title>`). With one shared title the builds unmounted each other at random (22 Oct: "No such file …
  .background/dmg-background.png", `hdiutil detach … No such file`). So `dmg.title` is `Grooveline Broadcaster${arch}`:
  the Intel volume keeps the plain name, the Apple Silicon one is `Grooveline Broadcaster-arm64`.
- `scripts/mac-deps.sh` fetches the pinned, checksummed ffmpeg and sox into `bin/mac/x64` and `bin/mac/arm64` (`bin/` is
  gitignored); electron-builder copies `bin/mac/${arch}/` into each app.

## Commands

```bash
npm start                    # Run in dev mode
npm run dev                  # Run with DevTools open
npm run dist:mac             # Build macOS DMG (universal arm64+x64)
npm run build:win            # Build Windows NSIS installer (run as Administrator)
npm run build:linux          # Build Linux AppImage/.deb
scripts/mac-deps.sh          # Fetch the pinned ffmpeg+sox for macOS into bin/mac/{x64,arm64}/
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
- The macOS canvas-video path is supervised since 1.6.2 (each launch asks the page for a new MediaRecorder).
- Renderer shows RECONNECTING with a banner (stage text + How to fix) via `stream-reconnecting` / `stream-reconnected`.
- Reports to `POST /setup/report` (app_live, app_error, app_reconnecting,
  app_reconnected, app_gave_up) when the DJ is logged in (`_acctToken` in config).
- `maskSecrets()` in `safeSend` masks `icecast://user:<pw>@` and RTMP keys in
  everything sent to the log — never log a raw URL around it.

### In-app stream check (1.3.0 "sound check", renamed Stream check in 1.5.0)

The **Stream check** card on ON AIR (or the strip button): sign in (`acctLogin`)
→ START. `GET /check/mount` (IPC `api-check-mount`) gives the DJ's private
`/check-*` mount, the same one the website's sound check uses. The answer comes
from `GET /check/status` (our Icecast), polled every 3 s, never from ffmpeg.
- The check destination is a one-off override, `toggleLive(ev, checkProfile)`.
  It is **never saved into `cfg`**, and the DJ's own destinations are ignored for the run.
- `main.js` refuses `soundCheck: true` unless there is exactly one Icecast profile on
  `/^\/check-[a-z0-9-]+$/` (forced audio-only). This guard keeps a test off a public mount.
- Status reads STREAM CHECK. `reportSetup` details keep the prefix `sound check:` (telemetry, unchanged).
- LISTEN plays `https://<server>/<mount>` in the app. The hint says headphones only,
  and never with a virtual cable as the system output.
- 401 within `AUTH_GRACE_MS` retries every 5 s: a new mount needs the 1-min sync.
- 403 text now says how long the wait is: ~1 min on `/check-*`, up to 10 min elsewhere.
- Fixed: signing in after launch left `cfg` without `_acctToken`, so the next
  `saveCfg()` dropped the token.
- e2e: a Playwright `_electron` harness outside this repo (temp account, decoy destination).

### Grooveline-only destinations + radio fallback (1.4.0, 21 Oct 2026)
- **Only two destination types:** `icecast` (Grooveline Radio) and `mediamtx` (Grooveline Video,
  `rtmp://46.224.177.15:1935/live/<stream_key>`). YouTube, Twitch, Mixcloud, Facebook, SHOUTcast and Custom RTMP were
  removed (Zé's decision); Grooveline restreams to its own channels server-side later. Old saved profiles of other
  types are dropped on start.
- **One destination per show.** `pickShow()` in the renderer: Grooveline Video wins when it's on; otherwise the
  enabled radio (the booking's `_grooveline` one first). `start-stream` in `main.js` refuses anything but exactly one
  `icecast`/`mediamtx` profile, so the broken multi-output branch of `buildTeeArgs` is never reached when live.
- **Video slot → radio fallback.** Every booking has an Icecast mount, rtmp bookings too. Loading a video slot keeps
  that radio profile (off) as `fallbackProfile`.
  - Windows/Linux: `pickCamera()` in `launchPipeline` (so every relaunch too) resolves "Default Camera", stale
    indexes and unplugged cameras to the first camera found. No camera → `fallBackToRadio()`.
  - A camera error while live is its own stage, `camera` (`CAMERA_LINE`, sticky over the generic "Error opening
    input" lines that follow). With a fallback it switches to the radio within 2 s; without one it gives up after 3
    with a camera message, never "the audio input failed".
  - macOS: the renderer falls back when `startCanvasCapture` fails.
  - The UI shows `LIVE ● RADIO ONLY` (`stream-fallback` event).
- **Site gap, fixed server-side on 22 Oct (worker `0941e324`):** `/api/live` counts a live MediaMTX publish (HLS playlist
  200) for an rtmp booking, and reports a radio fallback as `icecast`, so the home page plays the right player.

### Cameras (1.3.1, 21 Oct 2026)
- The camera picker (`#video-row`) is always shown since 1.6.3 (1.4.0–1.6.2: only with Grooveline Video enabled).
- **Hot-plug:** `watchDeviceChanges()` rescans on Chromium's `devicechange` (Windows, macOS and Linux), debounced
  1.2 s. While live it only logs; the rescan restarts the preview, so it never runs mid-stream.
- **Linux:** `listV4l2Devices()` reads `/sys/class/video4linux` (no v4l-utils needed) and keeps only `index` 0
  nodes, because UVC cameras also register a metadata node. The option's `avIndex` is the `/dev/videoN` path.
  `buildTeeArgs` falls back to the first camera when it gets anything else; before this it passed `-i 0`, which
  ffmpeg can't open.
- **MacBook FaceTime HD on Linux** needs the `facetimehd` DKMS driver: YUYV only, 30 fps, up to 1280x720.

### Device flow

1. `list-audio-devices` IPC → ffmpeg `-list_devices` (AVFoundation/dshow) or `pactl` (Linux) → returns `{ devices[], videoDevices[] }`
2. Renderer merges with `enumerateDevices()` results, tags each browser option with `data-ffmpeg-index` / `data-ffmpeg-name` / `data-av-index` / `data-ds-name`
3. `probe-audio-channels` IPC → 0.1s ffmpeg probe → returns `{ channels, nativeSampleRate }`
4. Channel picker built from channel count — sox always captures `max(cL,cR)+1` channels, ffmpeg `pan=` filter routes selected pair

### Binaries

- `bin/mac/x64/`, `bin/mac/arm64/` — `ffmpeg` and `sox` per app architecture (populated by `scripts/mac-deps.sh`)
- `bin/win/` — `ffmpeg.exe` (populated by `prepare-binaries-win`)
- Linux — system ffmpeg from PATH, no bundling
- `findFFmpeg()` checks `process.resourcesPath` first (production), then PATH (dev)

### 1.5.0 redesign (21–22 Oct 2026)
- **Layout:** header (brand, version chip → About, status pill, account), tabs ON AIR / RECORDING / NOW PLAYING / LOG /
  HELP / SETTINGS, and an always-visible right strip (status, L/R meters, volume fader, GO LIVE, Stream check, REC).
  ON AIR = your slot → your input → Stream check. The Destinations tab is gone: the next booking loads by itself
  after sign-in (`acctFetchBookings` → `acctLoadCredentialsFromBooking`); 1.6.0 removed hand entry.
  `refreshUI()` decides every status text, banner and button from the state; call it after changing state.
- **Harness ids kept on purpose:** `log-output`, `stat-status`, `st-sub`, `btn-go-live`, `btn-record`, `slot-body`,
  `c-signin`, `video-row`, `video-device`, `preview-video`, `preview-ph`, `acct-load-msg`, `chk-*`, `set-recshow`, and the
  functions `toggleLive`, `toggleRecording`, `setRecFmt`, `pickShow`, `startAppCheck`, `endAppCheck`, `openCheckModal`,
  `acctFetchBookings`, `acctLoadCredentials`, `acctShowLoggedIn`, `setLive`, `refreshUI`. The harnesses in
  `~/.local/share/gl-testing/` (outside the repo) use them, and the boot log line must still contain "Ready.".
- **Meters:** while live, every ffmpeg command ends with `meterTapArgs()`: the stream's own audio chain (pair + volume)
  as 16-bit 44.1 kHz stereo on stdout. `attachMeterTap()` computes peak/RMS per 1470 frames and sends `meter` IPC at
  30 Hz; it also feeds live recording (`recMode 'pcm'`). **stdout must always be drained**, or ffmpeg blocks and the
  supervisor loops on stalls. Linux video has audio on input 1 (`-map 1:a?`).
  Before going live: Linux runs a meter-only ffmpeg on the exact Pulse/PipeWire source (`meter-preview-start`; Chromium
  can't open monitors); Windows/macOS use Web Audio with the same pair and volume. Scale: dBFS −60…0, IEC-style.
- **Linux input:** ffmpeg gets the Pulse/PipeWire source *name* (`pulseSource()`). Until 1.5.0 it got a list position,
  which PipeWire silently replaces with the default source. `findFfDevice()` matches labels exactly first and never
  maps a non-monitor label to a monitor.
- **Volume:** 0–100 % (`?? 100`, never `|| 100`), locked while live: ffmpeg gets it at launch only.
- **Build info:** `scripts/stamp-build.js` is electron-builder's `beforePack` hook and writes `src/build-info.json`
  (gitignored): commit from `GITHUB_SHA`, else git, else `build/commit.txt` (filled by `git archive`, export-subst).
- **Logs:** `<userData>/logs/broadcaster.log` + 4 previous sessions, written by `writeLog()` in main (every
  `stream-log`, plus renderer lines via `log-write`), masked. `tech: true` marks raw ffmpeg lines (Technical view).
- **About / What's new / updates:** `get-app-info`, `get-changelog` (CHANGELOG.md is packaged), `check-update` reads
  `https://downloads.grooveline.org/latest.json` (`{"latest":{"linux":"x","win32":"y","darwin":"z"},"url":…}`); a
  missing file is silent.
- **Window:** macOS `hiddenInset`, Windows `titleBarOverlay`, Linux native frame with no menu bar. The session
  permission handler must allow `fullscreen`, or the camera preview's double-click full screen is refused silently.

### 1.5.1 (22 Oct 2026)
- **Quit closes the camera first:** the window `close` handler and `force-quit` call `releaseDevices()`. It sends
  `release-devices` (the page stops its preview and canvas capture), then on Linux waits until no process in our tree
  holds a `/dev/videoN` (`videoHolders()`, max 2.5 s). Background: on 22 Oct, with the preview open, a plain close killed
  Chromium's capture process mid-stream, and facetimehd logged `IO: timeout` plus ~2,800 DMA faults; a stopped track
  or a SIGTERM'd ffmpeg logs nothing. `kill -9` of the app while live is fine: ffmpeg exits when its meter-tap pipe
  breaks.
- **What's new** lists every CHANGELOG section after `lastSeenVersion` (missing = 1.4.0), so 1.4 → 1.5.1 also shows 1.5.0.
- **Linux cameras Chromium can't see:** facetimehd master (PR #331) reports frame sizes as a STEPWISE range, and
  Chromium lists no camera then. The dropdown still shows it (from sysfs) and GO LIVE streams it via ffmpeg.

## Historical: video streaming blocker (2026-04-09)
This is about the macOS canvas path and predates the supervisor; re-check before relying on it.

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
  - `bin/mac/x64` ffmpeg (minos 10.12) and sox (minos 10.10) are x86_64-only; `bin/mac/arm64` ffmpeg (minos 12.0) and
    sox (minos 11.0) are arm64-only (1.6.3). All link only `/usr/lib` and `/System`.
- **Windows build must run as Administrator.**

### 1.6.0 (22 Oct 2026)
- **No destinations to enter.** Settings › Advanced and ADD DESTINATION are gone (Zé: "login should load them, and by
  date and hour be available to start"). On start, every profile not loaded from a booking is dropped (logged), and all
  of them when signed out. The slot card says "No camera → your audio goes to the radio by itself" (no toggle).
- **GO LIVE by slot time:** open from start − 15 min until the slot ends (`slotWindow`, `GO_EARLY_MS`). Times are the
  server's clock: `apiRequest` returns the `Date` header and `noteServerDate` keeps `clockOffset`. States NOT YET /
  READY / SLOT ENDED; `refreshUI` re-runs every 10 s while idle. The Stream check is not gated.
- **Fresh details at every GO LIVE:** `toggleLive` reloads the credentials first (offline: the last load). Profiles use
  the API's `rtmp_url` and `server:port`; `rtmpUrlOf()` in main falls back to base + key. `start-stream` refuses a video
  profile without one.
- **RTMP refusals:** MediaMTX accepts the connection and closes it ~2 s later when the key is denied; ffmpeg only sees a
  reset. A video launch that dies within `RTMP_REFUSED_MS` (12 s) before `RTMP_CONFIRM_MS` (5 s) of sending is stage
  `refused`; 3 in a row → give up with a slot-time/key message. Video sessions hold stream-stats ("ON AIR") and
  "Connected" until 5 s of sending. Video retries back off 5/10/20/30 s (each relaunch reopens the camera).
- **classifyLine** matches only "Server returned / HTTP error 401|403": 1.5.1 read libx264's `kb/s:403.68` as a 403.
- **Video shows recorded locally (default on, RECORDING › Record my video shows):** one encode, `-f tee` with an FLV
  branch and a Matroska branch (`onfail=ignore`, `-flags:v/a +global_header`, else FLV has no sequence headers). One
  `.mkv` part per launch (`nextShowPart`), joined to one MP4 by `finishShowRecording` on STOP / give-up (parts < 6 s are
  dropped; a part without a duration is read through). STOP sends `q` to ffmpeg's stdin (`_qStop`) so files get their
  trailer; SIGTERM after 3 s. A quit while live leaves the `.mkv` parts. `maskSecrets` stops at `|` and `]`.
  `teePath()` escapes paths for tee (forward slashes, `'|[]`). macOS canvas path has the same branch.
- **Camera formats:** `v4l2InputArgs` / `dshowVideoArgs` ask the camera once (cached) and pick MJPEG at the stream size,
  else raw at that size, else the smallest size that covers it, else the largest below (`pickCamFormat`). Logged as
  "Camera: …" (tech). facetimehd → `yuyv422 1280x720`.
- **MP4 with the camera when not live (Linux/Windows), mode `cam`:** the page stops its preview, main waits for
  `videoHolders()` to empty (Linux), ffmpeg records camera + input; stopped with `q`; the preview restarts on
  `recording-stopped`. The old `hls` live-recording mode is gone.
- **Fewer camera opens:** the device-name probe runs only when labels are missing; on Linux an input change swaps only
  the ffmpeg meter (`refreshPreviewAudio`). A camera Chromium can't open shows "No preview for this camera. It still
  streams when you go live."
- **Tests** (`~/.local/share/gl-testing/`): `gl-slot-mock.mjs` (signed-in DJ + slot, booking API mocked in main, local
  fakes, server-clock shift), `bc-160-scenarios.mjs` (no camera, through `nocam-exe.sh`), `bc-160-checks.mjs` (levels,
  REC, log), `bc-160-video.mjs` (REAL camera, tell Zé first; local RTMP sinks :19935 accepting, :19936 dropping after 2 s).

### 1.6.1 (22 Oct 2026, from the Mac test on the Samsung-stick handoff)
- **Input matching:** `findFfDevice` adds a word match after exact and substring. macOS names the mic "Internal
  Microphone (Built-in)" in Chromium and "Built-in Microphone" in CoreAudio/ffmpeg. The shorter name's words must all be
  in the longer one (2+ words), and the closest pair wins. On macOS the default option falls back to sox's `default`
  keyword (sox `coreaudio.c`: `strncmp(name, "default", 7)` = CoreAudio's default input; an empty name opens nothing).
  **Never `devices[0]`:** 1.6.0 streamed Soundflower (silence) for a whole Mac show. An unmatched input sets
  `inputUnmatched` and blocks GO LIVE and the Stream check. Windows `start-stream` refuses instead of taking the first
  dshow input. The `Input:` log line names the device that streams when it differs from the label.
- **Meters:** `.bar .mask` is 86 % opaque, so the zones always show faintly. A new meter source (preview, tap, live)
  shows silence for 600 ms and resets CLIP and peak hold: a stray first sample latched CLIP on the Mac.
- **REC while a video show records:** "● SHOW hh:mm:ss", then SAVING… after STOP, and ✓ SAVED for 4 s on `recording-stopped`.
- **Mac video path:** ffmpeg starts first and sox once ffmpeg prints `Input #0` (15 s fallback). Before, sox filled
  the pipe during the ~6 s webm probe and CoreAudio dropped audio (1012 overruns in a minute; the MP4 was 52 s for an
  83 s show). Every 10 s a tech line `[mac video] ffmpeg time=… speed=…x · sox dropped audio N× in the last 10 s`
  replaces one log line per overrun. **Unverified on a Mac.**
- Not done: an ffmpeg/sox preview meter for inputs only ffmpeg lists on macOS/Windows (most go away with the matcher).
- **Video check:** Stream check › "Start video check" (shown when a camera is found; no slot needed, so a long test run
  never books, and so never announces, a slot). `/check/mount` returns `video_key` (`vcheck-` + 20 hex, an HMAC of the user
  id), `video_rtmp_url` and `video_watch_url` (grooveline.org/watch). The server lists every DJ's key as an always-open
  rtmp window, and `/live` never sees it: no site switch, no recording, no posts. `start-stream` allows a soundCheck
  only to `/check-*` (audio) or `rtmp://46.224.177.15:1935/live/vcheck-…` (video). "Received" = `check-video-status`
  (HLS playlist 200). Tested end to end on 22 Oct with Zé's account: playlist 200, /watch played, `/live` stayed false.

### 1.6.2 (29 Oct 2026, from the Mac test on the Samsung-stick handoff)
- **Hidden window froze Mac video:** Chromium paused the page (rVFC/rAF draw loop, timers at 1 Hz) when the window was
  minimized, hidden or on another Space; ffmpeg waited for video, the sound stopped too, MediaMTX cut after 60 s. Now
  `backgroundThrottling: false`, `disable-renderer-backgrounding`, `disable-backgrounding-occluded-windows`,
  `CalculateNativeWinOcclusion` in the one `disable-features` switch (a second switch replaces the first), and
  `powerSaveBlocker('prevent-app-suspension')` while live (`liveSession.noSuspend`). The April fix (setInterval loop,
  `5d2d745`) was lost in the 4 May restore and wasn't enough anyway (1 frame/s when hidden).
- **Mac video supervised:** `startVideoStream` tags its procs, feeds `superviseLine`, calls `pipelineExited`. Each launch
  bumps `videoRecorderGen` and sends `video-recorder-restart`; the page starts a new MediaRecorder on the canvas stream
  (`startVideoRecorder(gen)`), and `video-chunk` drops chunks of any other generation, so every ffmpeg gets a webm
  stream from its header on. The page no longer starts a recorder in `startCanvasCapture`.
- **Lost stream slave:** `Slave muxer #0 failed` (slave #0 of the tee is always the stream) → stage network → relaunch,
  every OS. ffmpeg used to continue with the local recording only and keep reporting progress: ON AIR, nothing sent.
- **Camera track ended** (page) → `video-source-ended` → stage camera → radio fallback; the page stops its capture on
  `stream-fallback`.
- **sox → ffmpeg fd3:** sox starts with ffmpeg; main writes its stdout to fd3 without backpressure, up to
  `SOX_BUFFER_S` (20 s) queued, so sox is always read while ffmpeg probes the webm. Drops show in the `[mac video]` line.
- **Permissions:** `requestMediaPermissions` asks mic then camera only while `not-determined`; the page awaits
  `media-access` in `populateDevices` before any `getUserMedia`. Skipped under `--use-fake-ui-for-media-stream`.
- **Mac e2e on GitHub's Macs** (`.github/workflows/mac-e2e.yml`, `test/mac/e2e.sh`, `test/mac/e2e/freeze.mjs`): packaged
  app, Chromium's fake camera, BlackHole as default input, MediaMTX v1.4.0 with production's timeouts; a video show
  minimized, hidden, on another fullscreen Space, then a MediaMTX restart. Runs 1.6.1's `src/` (baseline, must fail) next
  to the current code (must pass) on macOS 15 arm64, 15 Intel and 26 arm64. **Never drive visibility tests with
  Playwright:** it turns on focus emulation, which keeps a hidden page running (the first e2e passed on 1.6.1). The harness
  uses Node's inspector in the main process and `webContents.executeJavaScript`. Results are `::notice` annotations.
- **Native Apple Silicon tools** (`scripts/mac-tools-arm64.sh`, job `arm64-tools`): ffmpeg 9.0.2 (Martin Riedl static,
  minos 12.0) and sox 14.4.2 built from source (CoreAudio + raw only); both arm64-only and system-libraries-only. Wired
  into the app in 1.6.3.

### 1.6.3 (29 Oct 2026)
- **Native Apple Silicon:** each Mac app carries its own architecture's tools: `mac-deps.sh` fills `bin/mac/x64` and
  `bin/mac/arm64` from `downloads.grooveline.org/build-deps/mac/` (never delete those keys), `package.json` copies
  `bin/mac/${arch}/`, `mac-sign-notarize.sh` signs and lipo-checks both sets, and `mac-smoke.sh` fails unless each app's
  tools are its own architecture only. 1.6.2's arm64 dmg bundled the x86_64 tools, which fail with "bad CPU type" on an
  M-Mac without Rosetta (macOS never offers Rosetta for a helper an arm64 app starts), so the site sent every Mac the
  Intel dmg. GitHub's arm64 runners have Rosetta, so only the lipo check catches a regression there.
- **Apple Silicon needs macOS 12:** the arm64 ffmpeg is minos 12.0. electron-builder has one `minimumSystemVersion` for
  both archs (Intel stays 10.15+), so the arm64 app shows a dialog and quits below Darwin 21.
- **Camera picker always visible** (Zé, 29 Oct: "otherwise people feel something is hidden from them"). On a radio slot
  (`cfg.audioOnly`) `startPreview` still asks for no video, so the camera light stays off; `toggleVideoSection` puts
  "Radio slot: your camera isn't sent." (or "The camera is used on video slots." with no slot) in `#preview-ph` and
  hides the full-screen button and hint (`setCamBox`). A video check is a one-off profile, so `cfg.audioOnly` stays true
  during it: `refreshUI` calls `setCamBox(cfg.audioOnly && !camSent)` (`camSent` = live, `liveShowIsVideo`, not on radio
  fallback), or the box would say "isn't sent" while the check streams the camera. `video-quality-section` still shows
  only on video slots.
- **SETTINGS tab** sits before HELP (the `.a-tab.right` push is gone).
- `test/mac/e2e.sh` plays its tone with the app's own sox and fails if the tone dies within a second (silence would
  stream just as well).

