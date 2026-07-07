# KILLIARDS

Turn-based online billiard combat. Last ball alive wins.

Pure static web app — **no backend**. All multiplayer traffic relays through
public MQTT-over-WSS brokers (EMQX / HiveMQ, used redundantly with message
dedup). WebRTC was deliberately dropped: it fails on many home networks (mDNS
candidates + no NAT hairpinning, and no public TURN exists anymore), while a
WebSocket relay connects in ~1-2s on any network — and a turn-based game never
notices the latency. The 5-letter room code is the host's locally generated id;
up to **6 players** per room.

Connection diagnostics: tap the logo 3× (or add `?debug` to the URL) for a live
connection log with a copy button.

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
- **Power-ups** appear on the table once in a while (max 3, gone after 4 turns).
  Whichever ball touches one stores it for *that player's* next shot — including
  balls you shove into them. Buffs: 💥 blast (first contact explodes), ⚡ boost
  (stronger shot), 💚 repair. Traps: ☠️ poison, 🐜 tiny ball, 🪨 heavy ball.
  Identity is visible: dodge the traps, or push enemies into them.
- Some tables have **teleporters** (paired rings that preserve velocity, with a
  re-entry lock) and **pushable barriers** (heavy glowing squares you can launch
  at people). They're simulated in the same recording, so replays stay exact.
- The host can add up to **3 bots** in the lobby (yellow ring); the host's device
  simulates their turns like normal shots, so guests just see turns arrive.
- **Emotes**: a reaction bar under the pad broadcasts floating emojis any time.
- Match ends when one player remains; ranking is by survival time. Before the
  ranking, the **best play** of the match (most damage + kills) is replayed —
  skippable, chosen identically on every device with no extra networking.

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
- `js/net.js` — relay transport over public MQTT brokers (host relays)
- `js/game.js` — turn conductor: live sim / replay / end-of-turn / ranking
- `js/ui.js` — screens, lobby state, roulette, ranking
- `js/main.js` — boot + message wiring

## Tests

- `node test/physics.test.js` — headless simulation checks (damage rules,
  obstacles, spin, recording size/consistency). No dependencies.
- `node test/e2e.test.js` — full 3-player match in headless Chromium
  (lobby → table select → roulette → turns → replay convergence → disconnect).
  Hermetic: the MQTT layer is shimmed over BroadcastChannel. Needs
  `npm i playwright-core` and a Playwright Chromium in the usual cache.
- `node test/relay.e2e.test.js` — live E2E: a 2-player match through the real
  public MQTT brokers. Needs internet.
