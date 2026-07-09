# KILLIARDS

Turn-based online billiard combat. Last ball alive wins.

Pure static web app — **no backend**. All multiplayer traffic relays through
public MQTT-over-WSS brokers (EMQX / HiveMQ, used redundantly with message
dedup). WebRTC was deliberately dropped: it fails on many home networks (mDNS
candidates + no NAT hairpinning, and no public TURN exists anymore), while a
WebSocket relay connects in ~1-2s on any network — and a turn-based game never
notices the latency. The 5-letter room code is the host's locally generated id;
up to **6 players** per room.

Joining is one tap: the lobby's **🔗 Invite** button shares a direct link
(`?room=CODE`) via the native share sheet on phones, or copies it to the
clipboard elsewhere. Opening the link shows a live preview of the lobby
(code + who's inside) with the usual name/emoji/color pickers and a single
Join button.

Connection diagnostics: tap the logo 3× (or add `?debug` to the URL) for a live
connection log with a copy button.

## How it works

The core rule of the whole design: **exactly one device simulates each turn, and
everything random or physical it decides ships inside one authoritative payload.**
Nothing is ever computed independently on two devices, so states can never diverge.

- **Turn-based recorded replay**: the active player's device runs the whole physics
  simulation locally while recording body positions (30 fps) and every collision
  event. When everything stops, the recording plus the final authoritative state
  (positions, health, stored power-ups, barrier positions, remaining table
  power-ups) is sent to the other players, who replay it frame by frame.
  Everyone always ends up seeing exactly the same thing — no realtime sync needed.
- **Shared logical space**: the table is always 1600×900 logical units, scaled to
  fit each screen (aspect ratio preserved), so replays are faithful on any device.
- **Bot turns run on the host only.** Bots have no device, so the host simulates
  their shots exactly like its own; guests just receive a normal turn recording.
  Never simulate a bot anywhere else — two simulators means two histories.
- **Bots plan by auditioning shots.** Because the physics are deterministic,
  the planner (`js/botai.js`) silently runs candidate shots through the same
  `Sim` on cloned state and picks the best outcome (damage, kills, self-harm,
  power-ups, final position). Difficulty (EASY/MID/HARD, set per bot in the
  lobby) is the number of candidates, the scoring weights, and how much
  execution error is added after deciding. A full HARD plan takes ~20 ms.
- **Invite links peek before joining.** The invited page connects like a normal
  guest and asks for the roster (`peek`); since the host already broadcasts
  lobby changes to every connection, the preview stays live for free. The seat
  is only taken when the player sends their profile.
- **Power-up spawns are rolled once**, by the device that just finished a turn,
  and shipped inside that turn's payload — no separate spawn message, no race.
- **Turn recordings queue.** A recording can arrive while a device is still
  replaying the previous turn (bot turns make this common: the host plays on
  without waiting for anyone's replay). Applying it immediately would clobber
  the running replay and desync the turn counter, so it waits in a queue until
  the device is idle.
- **Barriers are just extra bodies** in the recording (frames carry balls first,
  then barriers), and teleporters are static table features with a re-entry
  lock — so both replay exactly like everything else.
- The moment a shot is fired, a tiny `shot` notice is broadcast (the recording
  itself only ships once the physics settle) so the other devices can show a
  **SIMULATING…** status instead of a mysteriously frozen table.
- The **best play** replayed at the end is scored identically on every device
  from the turn payloads (damage to others + kill bonus), so everyone agrees on
  it with zero extra networking.

## Rules

- Slingshot drag to shoot; optional spin (hit point) widget changes how the ball
  behaves on its **first** contact. You get **60 seconds** per turn (the clock
  only ticks while your app is focused) — when it runs out, the shot fires itself.
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
- The host can add up to **3 bots** in the lobby (yellow ring) and tap each
  bot's chip to set its difficulty (**EASY / MID / HARD**); the host's device
  simulates their turns like normal shots, so guests just see turns arrive.
- Names are optional: nameless players (and bots) show their **emoji** in the
  turn banner, roulette, lobby and ranking instead.
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
- `js/tables.js` — table definitions (obstacles, teleporters, barriers, spawns), palettes
- `js/physics.js` — fixed-step simulation & recording: damage rules, spin,
  barriers, teleporters, power-up pickups and shot effects, `POWER_KINDS`
- `js/render.js` — canvas renderer: neon borders, balls, bars, power-ups,
  teleporters, barriers, particles, floating emotes, shake
- `js/controls.js` — slingshot pad + spin widget
- `js/net.js` — relay transport over public MQTT brokers (host relays)
- `js/botai.js` — bot shot planner (candidate simulation + scoring, difficulty
  levels); pure physics, also runs headless in Node
- `js/game.js` — turn conductor: live sim / replay / turn queue / power-up
  lifecycle / bot turns / shot clock / best play / ranking
- `js/ui.js` — screens, lobby state (incl. bots + invite peek), roulette, ranking
- `js/main.js` — boot + message wiring (turn/shot/emote relays, emote bar,
  invite links)

## Contributing

PRs are welcome if they bring improvements — gameplay, tables, netcode, fixes,
whatever makes the game better. Two things to keep in mind:

1. **Respect the one-simulator rule** described above: any new mechanic must be
   decided on the simulating device and travel inside the turn payload. If two
   devices could compute it independently, it will desync.
2. **Keep the tests green** (`node test/physics.test.js` and
   `node test/e2e.test.js`) and add coverage for new mechanics — the physics
   suite has no dependencies, so there's no excuse. 🙂

## Tests

- `node test/physics.test.js` — headless simulation checks (damage rules,
  obstacles, spin, recording size/consistency). No dependencies.
- `node test/bots.test.js` — headless bot-AI checks: shot sanity, planning
  speed, and full bots-only matches asserting HARD beats EASY. No dependencies.
- `node test/e2e.test.js` — full 3-player match in headless Chromium
  (invite link + lobby → bot levels → table select → roulette → turns → replay
  convergence → disconnect). Hermetic: the MQTT layer is shimmed over
  BroadcastChannel. Needs `npm i playwright-core` and a Playwright Chromium in
  the usual cache.
- `node test/relay.e2e.test.js` — live E2E: a 2-player match through the real
  public MQTT brokers. Needs internet.
