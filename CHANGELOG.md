# Changelog

The app shows the sections newer than the version you had before under "What's new" the first time it opens.

## 1.6.1

- Mac: "Default input" now streams your Mac's default input. 1.6.0 could pick another device (a silent loopback driver) while the preview looked fine.
- The app finds your input by name more reliably, and if it can't, it says so and waits before GO LIVE instead of streaming a different device.
- The level meters always show their green, yellow and red zones, and CLIP no longer lights up when the input starts.
- While a video show is recorded, REC shows it (SHOW and the time), then SAVING… and ✓ SAVED after STOP.
- Mac video shows: the sound starts together with the picture, and the log reports every 10 s if the Mac can't keep up.

## 1.6.0

- Your slot is your destination. Sign in and the app loads it; there is nothing to enter by hand any more, and destinations entered by hand before are removed.
- GO LIVE opens 15 minutes before your slot starts and closes when it ends, by Grooveline's clock. The Stream check works any time.
- Every GO LIVE loads your slot's details again, so an old stream key can never go out.
- Video slots: with no camera, your audio goes to the radio by itself. There is nothing to switch on.
- Video shows are recorded on your computer and saved as MP4 when you press STOP (RECORDING › Record my video shows).
- Linux and Windows: MP4 recordings on a video slot now include the camera when you are not live.
- USB webcams stream at full quality: the app uses the camera's MJPEG mode at your stream size when it has one.
- When Grooveline's video server refuses a stream, the app says so and stops after 3 tries instead of retrying forever. "Connected" now shows only once the server has accepted the stream.

## 1.5.1

- Quitting the app now stops the camera cleanly first. On some Linux laptops a camera cut off mid-stream could stop working until a restart.

## 1.5.0

- A new main screen, ON AIR: your slot, your input and Stream check in one place, with status, level meters, volume and GO LIVE always on the right.
- Your next slot loads by itself after you sign in. No more "Load to destinations".
- New level meters in dB, with peak hold and a CLIP light. While you're live they show exactly the audio Grooveline receives.
- "Sound check" is now called Stream check, and it runs on the main screen.
- Stream volume goes up to 100%, which is your input unchanged. If you're too quiet, raise your mixer's master.
- Linux: the input you pick is the input that streams. Before, Linux always streamed the system's default input.
- Recording during a live show records exactly what Grooveline receives. Before, it saved an empty file.
- When the app has to stop, the reason stays on the main screen, with a "How to fix" link.
- Version, About, Help, update notices and a log file you can save.
- Video slots: double-click the camera preview for full screen.
- The Monitor output setting is gone: it played your input back through your speakers.

## 1.4.0

- Grooveline only: streams to Grooveline Radio or Grooveline Video.
- A video slot with no camera streams your audio to the radio instead.

## 1.3.0

- In-app sound check on a private test mount, with Listen.

## 1.2.0

- Reconnects by itself until you press STOP.
