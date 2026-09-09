# Protocol — Client ↔ Server Contract

Message/state contract per Room, so the Unity client and Colyseus server (built independently) don't drift on names/shapes. Dakon and Egrang are implemented and settled below; only Engklak is still `TODO`, pending its rules doc in [games/](games/).

## Shared conventions (all rooms)

- **Join:** client calls `joinById(roomId)` to join an existing room, `create(roomName, options)` to make a private one, or `joinOrCreate(roomName, options)` for public matchmaking. `options`: `{ private?: boolean, displayName?: string, playerId?: string }`. `playerId` is the client's stable GUID and is stats-only — never authorisation (see [database.md](database.md)). Room codes are 6-char (see [room-system.md](room-system.md)).
- **Starting:** `phase` starts `"waiting"`. The **host** sends `start_game` (no payload) once at least `minPlayers` are seated (2 for both Dakon and Egrang); the room also starts by itself when it fills to `maxClients`, since there is nothing left to wait for. On start the phase flips to `"in_progress"` and the room locks. A rejected start is an `error` message — the player stays seated. Codes: `not_host`, `not_enough_players`, `already_started`.
- **Seats:** every player carries a 0-based `seat` in `state.players`, assigned on join and reused when a seat frees up. Games map it to sides (Dakon seat 0 sows from hole 0).
- **State sync:** server is authoritative; state is an `@colyseus/schema` object, auto-diffed to clients on every mutation. Clients never send state directly — only messages (events).
- **Client → server messages:** sent via `room.send(type, payload)`. Server validates every message; invalid ones are rejected via the shared error message below, never silently dropped or trusted.
- **Server → client:** either a state patch (schema diff, automatic) or an explicit message via `client.send(type, payload)` / `this.broadcast(type, payload)`.
- **Shared error/edge messages** (all rooms should emit these where applicable):
  - `error` — `{ code: string, message: string }`. Codes at minimum: `invalid_move`, `not_your_turn`, `room_full`, `room_not_found`.
  - `player_joined` / `player_left` — `{ sessionId: string }` (may be redundant with schema-level player list changes; keep only if the client needs an explicit event vs. diffing the list).
  - Reconnect: use Colyseus's built-in `allowReconnection(client, seconds)` on `onLeave` for graceful drop/reconnect — don't hand-roll a custom reconnect message unless the built-in proves insufficient.

## Dakon

Room name: `dakon` (implemented — `DakonRoom` + `src/games/dakon/DakonBoard.ts`). Rules: [games/dakon.md](games/dakon.md). 2 seats, starts when both are in.

The board is the **v6 ruleset**, the one the Unity client implements: a 20-hole ring (10 per side), types shuffled per side, a 60-seed pool, 15 seeds drawn per turn — 4 hands, 2 turns each.

- **State schema** (`DakonState`, on top of the shared `phase` / `hostSessionId` / `players`):
  - `centerPoolCount: number` — seeds still undrawn. The game ends when it hits 0.
  - `holes: string[20]` — each `"monocot" | "dicot"`. Ring order: indices 0–9 = seat 0's side, 10–19 = seat 1's. Fixed for the match, and now fixed *across* matches: it is the constant `DAKON_HOLE_TYPES`, pinned to the icons painted on the client's board (see `docs/games/dakon.md`). Still sent every match rather than assumed — the client renders what it is told. Holes hold no seeds between drops — each drop is swept immediately.
  - `activePlayer: string` — sessionId of the player to act.
  - `nextHoleIndex: number` — the forced destination of the next drop. Advances by 1 and wraps around the ring, so a 15-seed hand spills onto the opponent's side.
  - `hand: { id, category, typeId }[]` — the active player's undropped seeds (15, or fewer on the final draw). Public rather than private: simplest authoritative shape, and the client decides what to render for whom. `category` scores; `typeId` is the species (a Unity `SeedType` asset name) and is cosmetic.
  - `storehouses: { [sessionId]: { monocot, dicot, total } }` — scored seeds, split by category because the client renders two bins per side.
- **Client → server:**
  - `drop_seed` — `{ seedId: string, holeIndex: number }` — one per message, sequential. `seedId` must be in `hand`; `holeIndex` must equal `nextHoleIndex`. The server validates, applies the sweep (score → clear → advance) and patches state before the next drop is accepted.
  - `start_game` — shared, see above.
- **Server → client:**
  - State patches after every drop, and after every draw (new `hand`, possibly short).
  - `error` — `{ code, message }`: `not_your_turn`, `invalid_hole` (not equal to `nextHoleIndex`), `seed_not_in_hand`, plus `invalid_move` for a malformed payload or a drop outside a match.
  - `game_over` — `{ scores: { [sessionId]: number }, winner: string | null }` — `null` = tie. Emitted when the pool is exhausted after the final sweep, and also when a player walks out mid-match (the remaining player wins by forfeit).

Board determinism: the shuffle/draw RNG is seeded from the room code, so a match is reproducible from its results row. No client can choose it.

## Engklak

Room name: `engklak` (TBD).

- **State schema:** TODO — pending [games/engklak.md](games/engklak.md).
- **Client → server:** TODO — likely a discrete action message (e.g. `hop`, `throw`) per [games/engklak.md](games/engklak.md) once turn/action model is defined.
- **Server → client:** state patches for position/turn changes; `error` for invalid actions; `game_over` — `{ winner: string | null }`.

## Egrang

Room name: `egrang` (implemented — `EgrangRoom` + `src/games/egrang/EgrangRace.ts`). Rules: [games/egrang.md](games/egrang.md). 3 seats, host may start at 2.

Distance is counted in **strides** (0.5 m each on the client), never in world coordinates. The race is 50 strides.

- **State schema** (`EgrangState`, on top of the shared `phase` / `hostSessionId` / `players`):
  - `racers: { [sessionId]: { stick, stepUnits, place, ready } }` — `stick` is `0` persegi / `1` lingkaran / `2` segitiga; `stepUnits` is banked strides; `place` is `0` until the racer finishes, then `1..3`; `ready` is set once a stilt is chosen.
  - `finishUnits: number` — race length in strides. 50.
  - `startsAtMs: number` — wall-clock start, stamped 3 s ahead at game start. No step counts before it.
- **Client → server:**
  - `choose_stick` — `{ shape: 0 | 1 | 2 }` — while `phase === "waiting"`, and still
    while `phase === "in_progress"` as long as that racer hasn't banked a step yet
    (`stepUnits === 0 && place === 0`). The room can auto-start before the client
    has even loaded the stilt picker, so most real `choose_stick` sends land after
    the race has already started; it locks once that racer steps.
  - `step` — `{ result: 0 | 1 | 2 }` — Fail / Half / Full, worth 0 / 1 / 2 strides. The client grades its own press (the cursor sweeps in under a second; grading on arrival would misgrade it). The server bounds the rate instead: a press within 500 ms of the previous accepted one is rejected.
  - `start_game` — shared, see above.
- **Server → client:**
  - `step_taken` — `{ sessionId, result, stepUnits }` — one per accepted press, to everyone including the sender. Remote clients replay the stride animation from it; the sender uses it to confirm its prediction.
  - `error` — `{ code, message }`: `invalid_move` for a malformed payload, a step before the countdown, a step from an unseated or already-placed client, one inside the rate limit, or a `choose_stick` after the race is over or after that racer has already stepped.
  - `game_over` — `{ places: { [sessionId]: number }, winner: string | null }` — `0` means never finished. Emitted the moment the first racer crosses the line (or, in a race whose last place is taken by someone other than the winner, when all racers are placed).

Nothing about the skill-check bar is simulated server-side: the room stores outcomes, not cursor positions.

## Exhibition Museum scene

No room, no protocol — single-player, client-side only (see [overview.md](overview.md), [architecture.md](architecture.md)). Nothing to define here unless that assumption changes.
