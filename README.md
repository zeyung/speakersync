# SpeakerSync

Play music in sync on every phone, tablet, laptop and speaker you have, from a link: no App Store, no install, iPhone and Android.

**Open it:** https://zeyung.github.io/speakersync/ (on iPhone, Safari → Share → Add to Home Screen for an app icon).

- **Any device joins:** phones, tablets, laptops, TVs with a browser. Each one plays through whatever it's connected to: its own speaker, a Bluetooth speaker or headphones (paired in its Settings), AirPlay, a car stereo or a wired speaker. A web page can't pair Bluetooth itself, so pair as usual and SpeakerSync syncs whatever comes out.
- **Rooms:** one device starts a room and adds songs (audio files). Others join by scanning the QR code, typing the 4-letter code, or opening the shared link. Songs are sent directly to every device, including late joiners.
- **Sync:** devices share the host's clock, measured continuously over Wi-Fi (typically ±1 ms) and corrected for drift. Play, pause, seek and skip happen everywhere at once. A device joining mid-song jumps in at the right spot.
- **Per device:** a Delay slider, volume, and **L only / Both / R only**, so two devices can act like a pair of earphones.
- **Auto-sync:** one device's microphone listens while each device chirps in turn. Each device's delay (Bluetooth lag included) is measured and corrected, then checked again. Use a listening device that isn't playing through Bluetooth: turning on an iPhone's mic can move its sound off a Bluetooth speaker.
- **Sync test:** a click every half second on every device, to check by ear.

## Limits

- **Songs only:** it plays songs you add as files. iOS doesn't let web pages (or apps) capture Spotify or Apple Music.
- **Keep it open:** keep the page open with the screen on. Phones pause web audio when locked. The app asks the screen to stay awake.
- **iPhone:** an iPhone plays to one Bluetooth speaker at a time. That's an iOS rule for every app, so put each speaker on its own device.
- **Connecting:** devices find each other through the free [PeerJS](https://peerjs.com) connection service, which only handles the first handshake. Songs and timing then flow directly between devices. Devices should be on the same Wi-Fi: across different networks, some connections may fail without a relay (TURN) server.

## Run locally

```bash
python3 -m http.server 8080
```

Open http://127.0.0.1:8080 in two browser tabs to try a room on one computer. Phones need the app served over **https** (like the GitHub Pages link above) for the microphone and screen-awake features.

## Tests

```bash
node --test sync.test.js room.test.js
```

## Files

- `sync.js`: clock sync, start-time math, chirp detection, Auto-sync math, room codes (pure, tested)
- `audio.js`: this device's sound (Web Audio): synced start, left/right routing, chirps, clicks, mic recording
- `room.js`: rooms over WebRTC: joining, song transfer, playback commands, drift correction, Auto-sync orchestration
- `app.js`, `index.html`, `style.css`: the interface
- `manifest.webmanifest`, `icon*.png`, `icon.svg`: lets phones "Add to Home Screen" like an app
