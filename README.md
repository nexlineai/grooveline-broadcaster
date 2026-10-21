# Grooveline Broadcaster

Stream your DJ set live to [Grooveline Radio](https://grooveline.org). Desktop app for macOS, Windows and Linux.

- **Sign in with your grooveline.org account.** Your booking's stream details load by themselves, so there's nothing to copy.
- **Sound check.** A private test stream that never goes on air. Our server tells you when it hears you, and you can listen back.
- **Reconnects by itself** after a Wi-Fi drop.
- It can also stream to any Icecast or SHOUTcast server, or over RTMP (YouTube, Twitch and others).

## Download

**[grooveline.org/broadcast](https://grooveline.org/broadcast)**

## Build from source

You need Node.js 18 or newer.

```bash
npm ci
npm start
```

- **Linux:** uses the system `ffmpeg`, plus PulseAudio or PipeWire.
- **Windows:** put `ffmpeg.exe` in `bin/win/` (`npm run prepare-binaries-win`), then run `npx electron-builder --win`.
- **macOS:** needs `ffmpeg` and `sox` in `bin/mac/`. `scripts/mac-deps.sh` fetches the exact, checksummed copies the
  release uses.

## Releases

The [build workflow](.github/workflows/build.yml) makes unsigned test builds for all three systems on every push.
Signed and notarized Mac releases are built in GitHub Actions too, only from version tags and only after the
maintainer approves the run.

## License

[MIT](LICENSE). The bundled `ffmpeg` and `sox` are separate programs under their own licenses.
