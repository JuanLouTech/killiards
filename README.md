# KILLIARDS

Turn-based online billiard combat. Last ball alive wins.

Pure static web app — **no backend**. Multiplayer uses [PeerJS](https://peerjs.com)
(WebRTC data channels brokered by the public PeerJS cloud + Google STUN), the same
approach as the Cyber Soccer prototype: the room creator's peer id is the 5-letter
room code and everyone connects directly to them.

## How it works

- **Turn-based recorded replay**: the active player's device runs the whole physics
  simulation locally while recording ball positions (30 fps) and every collision
  event. When all balls stop, the recording plus the final authoritative
  positions/health are sent to the other players, who replay it frame by frame.
  Everyone always ends up seeing exactly the same thing — no realtime sync needed.
- **Shared logical space**: the table is always 1600×900 logical units, scaled to
  fit each screen (aspect ratio preserved), so replays are faithful on any device.

## Rules

- Slingshot drag to shoot; optional spin (hit point) widget changes how the ball
  behaves on its **first** contact.
- Border contacts deal a fixed damage, but only on *new* contacts (each border
  edge has an id; sliding along the same border doesn't stack damage).
- Ball-to-ball hits damage the victim proportionally to the speed change.
  The player currently shooting is immune to ball damage (but not border damage).
- At 0 HP a ball explodes and leaves a grey **dead ball**: takes no damage, has
  extra drag, and can be pushed into living players as a weapon.
- Match ends when one player remains; ranking is by survival time.

## Run locally

Any static file server works:

```sh
cd killiards
python3 -m http.server 8000
```

Open `http://localhost:8000`. To test multiplayer, open a second tab/device
(same LAN works: `http://<your-ip>:8000`), create a room in one and join with
the code in the other.

To play across the internet, deploy the folder to any static host
(GitHub Pages, Netlify, Cloudflare Pages…). HTTPS recommended.

## Files

- `index.html` — all screens (home / lobby / roulette / game / ranking)
- `js/tables.js` — table definitions (obstacles + spawn points), palettes
- `js/physics.js` — fixed-step simulation, recording, damage rules, spin
- `js/render.js` — canvas renderer: neon borders, balls, bars, particles, shake
- `js/controls.js` — slingshot pad + spin widget
- `js/net.js` — PeerJS star topology (host relays)
- `js/game.js` — turn conductor: live sim / replay / end-of-turn / ranking
- `js/ui.js` — screens, lobby state, roulette, ranking
- `js/main.js` — boot + message wiring

## Tests

- `node test/physics.test.js` — headless simulation checks (damage rules,
  obstacles, spin, recording size/consistency). No dependencies.
- `node test/e2e.test.js` — full 3-player match in headless Chromium
  (lobby → table select → roulette → turns → replay convergence → disconnect).
  Needs `npm i playwright-core` and a Playwright Chromium in the usual cache.
  WebRTC is replaced by a BroadcastChannel-backed Peer shim because headless
  browsers launched from a shell on macOS can't complete ICE (Local Network
  permission); the real PeerJS path is the same proven setup as Cyber Soccer.
