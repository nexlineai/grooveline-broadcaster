# Grooveline Broadcaster

Stream your DJ set live to [Grooveline Radio](https://grooveline.org). Desktop app for macOS, Windows and Linux.

- **Sign in with your grooveline.org account.** Your next slot and its stream details load by themselves, so there's nothing to copy.
- **Stream check.** A private test stream that never goes on air. Our server tells you when it hears you, and you can listen back.
- **Level meters in dB** with peak hold and a CLIP light. While you're live they show exactly the audio Grooveline receives.
- **Reconnects by itself** after a Wi-Fi drop.
- **Grooveline only.** It streams to your slot on Grooveline Radio, or to Grooveline's video server for a video slot.
  With no camera, a video slot streams to the radio instead, so you're still on air.

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

## Version and logs

The version, commit and build date are in the app header (click the version for About). `scripts/stamp-build.js`
writes them into every packaged build. The app keeps a log of the last five sessions in its data folder (LOG › Open
folder), with passwords and stream keys masked. Release notes: [CHANGELOG.md](CHANGELOG.md).

## Releases

The [build workflow](.github/workflows/build.yml) makes unsigned test builds for all three systems on every push.
Signed and notarized Mac releases are built in GitHub Actions too, only from version tags and only after the
maintainer approves the run.

## License

[MIT](LICENSE). The bundled `ffmpeg` and `sox` are separate programs under their own licenses. The fonts in
`src/fonts/` (Orbitron, Rajdhani, Share Tech Mono) are under the SIL Open Font License; the licences are next to them.
