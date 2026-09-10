# Room System & Matchmaking

How rooms are created, joined, and managed. This is the **reusable** layer shared by
every game — implemented once in `src/rooms/BaseGameRoom.ts` and subclassed per game
(`DakonRoom`, and later `EgrangRoom`/`EngklakRoom`). Ground rules it obeys:
[boundaries.md](boundaries.md) (Colyseus features only, no third-party matchmaker),
lifecycle from [architecture.md](architecture.md), message/error contract from
[protocol.md](protocol.md).

One room is deliberately **not** on this layer: the hub's `museum` presence room
(`src/rooms/MuseumRoom.ts`) extends `Room` directly, because it has no match to manage —
no codes, host, seats, start or reconnection. See
[protocol.md](protocol.md#exhibition-museum-scene).

## Overview

`BaseGameRoom<S extends BaseGameState>` (abstract) owns everything that isn't
game-specific: short room codes, the private flag, the players map, seat assignment,
host assignment/migration, the host-driven `start_game` (plus auto-start when full),
reconnection, idle cleanup, join guards, and the persistence of who played what
([database.md](database.md)). A concrete game subclass only:

1. sets `maxClients` (and `minPlayers` if the host may start below a full room),
2. supplies its own state class (`extends BaseGameState`), and
3. implements four hooks — `createInitialState()`, `onRoomCreated()`, `onGameStart()`,
   `onOpponentLeft()` — plus `scoreOf(sessionId)` if it has scores worth persisting.

Shared state lives in `src/rooms/schema/BaseGameState.ts` (`phase`, `hostSessionId`,
`players: MapSchema<BasePlayer>`) and `BasePlayer.ts` (`sessionId`, `displayName`,
`seat`, `connected`). Schema inheritance means a game's own fields sync alongside
these. The stable `playerId` a client may send is held server-side only — it is a
stats key, not an authorisation one, and peers have no reason to read it.

## Starting a match

`start_game` (no payload) from the **host**, once `minPlayers` are seated. A room that
fills to `maxClients` starts on its own, because nothing is left to wait for. Egrang is
why the host button exists: 3 seats that may start with 2.

Rejections are `error` messages, not kicks — the player stays in the room:

| Code | When |
|---|---|
| `not_host` | a non-host sent `start_game` |
| `not_enough_players` | fewer than `minPlayers` seated |
| `already_started` | the match is running (also thrown as `ServerError 4001` on a late join) |

## The three join flows

All three are near-native to Colyseus 0.17 — no custom HTTP matchmaking endpoint. The
client passes `options` `{ private?: boolean, displayName?: string, playerId?: string }`.

| Flow | Client call (Unity SDK) | Server behavior |
|------|-------------------------|-----------------|
| **Create private room** | `client.create("dakon", { private: true, displayName })` | New room; `setPrivate(true)` hides it from public matchmaking. `room.roomId` is the shareable code. |
| **Public join-or-create** | `client.joinOrCreate("dakon", { displayName })` | Joins any non-full, non-private, non-locked room; creates one if none exist. |
| **Join by code** | `client.joinById(code, { displayName })` | Joins that specific room if it exists, has space, and hasn't started. |

Private rooms and locked/in-progress rooms are automatically excluded from
`joinOrCreate`, so public matchmaking never dumps a player into someone's private game
or a match already underway.

## Room code

- 6 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` — uppercase, digits, with
  ambiguous `0 O 1 I L` removed so it's easy to read/type at a kiosk (matches the
  `AB12CD` style in [architecture.md](architecture.md), dev-plan §5).
- Generated in `onCreate` via `generateRoomId()`, collision-checked against a Presence
  set (`$roomcodes`) so codes stay unique across server processes; released on
  `onDispose`. `this.roomId` **is** the code — `joinById(code)` uses it directly.

## Lifecycle

`waiting → in_progress → finished → (disposed)` — tracked in `state.phase`.

- **waiting** — lobby; players joining. An idle room still in `waiting` after
  `IDLE_TIMEOUT_MS` (5 min) auto-destroys (`disconnect()`).
- **in_progress** — set when the host sends `start_game` with `minPlayers` seated, or
  automatically the moment `clients.length === maxClients`. The room is `lock()`ed on
  start and the idle timer cleared.
- **finished** — set if a player leaves for good mid-match (see reconnection).
- **disposed** — Colyseus disposes the room when the last client is gone; the room code
  is freed from Presence in `onDispose`.

**Host:** the first joiner is `hostSessionId`. If the host leaves for good, the role
migrates to a remaining player (or clears if none remain). Only the host may send
`start_game`; a room that fills starts regardless of who is host.

## Reconnection

Uses Colyseus's built-in mechanism (per [protocol.md](protocol.md) — don't hand-roll):

- **`onDrop`** (unexpected disconnect): the player's `connected` flag → `false` and the
  seat is held via `allowReconnection(client, RECONNECT_SECONDS)` (30s).
- **`onReconnect`** (client returns in time): `connected` → `true`; match continues.
- **`onLeave`** (window expired, or consented `room.leave()`): the player is removed from
  `players`, `player_left` is broadcast, the host migrates if needed, and if the match was
  `in_progress` it ends (`phase = "finished"`, then `onOpponentLeft()`), and the match is
  persisted as `forfeited` (one player left) or `abandoned` (nobody left).

## Join guards & errors

- **room_full** — Colyseus rejects joins into a full/locked room before `onJoin`; the
  client sees a join error. (With Dakon's `maxClients = 2` + auto-start, a room is locked
  the instant it fills, so a 3rd `joinById` is always rejected.)
- **already_started** — `onAuth` throws `ServerError(4001, "already_started")` if
  `phase !== "waiting"`, guarding games where start isn't tied to being full.
- **room_not_found** — `joinById` with an unknown/expired code fails at the Colyseus
  matchmaker; the client sees a join error.

Broadcast events every room emits: `player_joined` / `player_left` — `{ sessionId }`.

## Extending for a new game

1. `src/rooms/schema/XState.ts` — `export class XState extends BaseGameState { /* game fields */ }`.
2. `src/rooms/XRoom.ts` — `export class XRoom extends BaseGameRoom<XState>`; set
   `maxClients`; implement `createInitialState`, `onRoomCreated`, `onGameStart`,
   `onOpponentLeft`; put move handlers in `messages` and keep rules in a plain TS class.
3. Register in `src/app.config.ts`: `rooms: { x: defineRoom(XRoom) }`.
4. Add `test/XRoom.test.ts` (mirror `test/DakonRoom.test.ts`) and document the room's
   messages/state in [protocol.md](protocol.md).
