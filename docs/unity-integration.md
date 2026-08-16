# Unity Client Integration

How the Unity WebGL frontend talks to this backend. Read [protocol.md](protocol.md) first for the exact message/state shapes per room — this doc is the "how to wire it up in Unity" companion, not a rules reference.

## 1. SDK & version

Use the **official Colyseus Unity SDK**, matched to the server's major version (`colyseus` `^0.17.x` here — see [tech-stack.md](tech-stack.md)). Install via the SDK's `.unitypackage`/UPM instructions from the Colyseus Unity SDK repo. Mismatched major versions between client SDK and server are a common source of "works in one, breaks in the other" bugs — pin both deliberately and bump together.

## 2. Endpoint configuration

Don't hardcode the server URL in scene objects. Use a single config point (e.g. a ScriptableObject or a build-time constant) with:

- **Dev:** `ws://localhost:2567` (matches `npm start`, see root README).
- **Production:** `wss://api.museum.fajrsyauqi.com` — a **different hostname from the one serving this WebGL build** (`museum.fajrsyauqi.com`), though both are the same VPS. See [deployment.md](deployment.md). Must be `wss://` (secure), not `ws://`, since the client is served over `https://` and browsers block mixed-content WebSocket connections. Cross-origin is fine: the matchmaker sends permissive CORS headers.

Don't point the client at a subpath of the client's own host (`wss://museum.fajrsyauqi.com/api`) — the Unity SDK builds its endpoint from host + port and has no path setting, unlike the JS SDK.

Colyseus SDK client construction:

```csharp
using Colyseus;

var client = new ColyseusClient(serverUrl); // "ws://localhost:2567" or "wss://api.museum.fajrsyauqi.com"
```

## 3. Exhibition Museum scene

No Colyseus connection at all — this scene is single-player/client-side only (see [overview.md](overview.md)). Don't instantiate a `ColyseusClient` here; only the 3 minigame scenes need one.

## 4. Creating / joining a room

Room names per game (see [protocol.md](protocol.md), TBD-confirm exact strings once rooms are implemented): `dakon`, `engklak`, `egrang`.

```csharp
// Create a new room (host flow) — server generates the shareable room code (roomId)
var room = await client.Create<YourGameState>(roomName, new Dictionary<string, object> {
    { "displayName", playerName }
});
string shareableCode = room.RoomId;

// Join an existing room by code (join flow)
var room = await client.JoinById<YourGameState>(roomId, new Dictionary<string, object> {
    { "displayName", playerName }
});
```

Handle both failure cases explicitly in UI, not just happy path: room not found/expired (`JoinById` throws), room full (server-side `onBeforeJoin`/`onJoin` rejection — surfaces as a connection error client-side, not a generic exception — check the SDK's exception message/code before assuming any failure means "not found").

## 5. Listening to state

State is authoritative and auto-diffed — never mutate a local copy and expect it to sync. Attach listeners once, right after join:

```csharp
room.OnStateChange += (state, isFirstState) => {
    // isFirstState == true on initial full snapshot; subsequent calls are diffs already applied to `state`
    RenderBoard(state);
};

// Or, for fine-grained per-field reactivity (schema callbacks), use room.State.listen("<field>", ...)
// per the Colyseus Unity SDK's schema callback API — prefer this over polling state in Update().
```

Don't poll `room.State` in `Update()` — use the SDK's change callbacks so the UI only re-renders on actual server-confirmed changes.

## 6. Sending messages

```csharp
room.Send("drop_seed", new { seedId = "...", holeIndex = 3 }); // Dakon example, see protocol.md#dakon
```

Message type strings and payload shapes must match [protocol.md](protocol.md) exactly — that file is the contract source of truth for both sides. If a message type/payload isn't in `protocol.md`, don't invent one client-side; flag it so the doc and server get updated together.

## 7. Handling server messages / errors

```csharp
room.OnMessage<ErrorPayload>("error", (msg) => {
    // msg.code: one of the shared codes (invalid_move, not_your_turn, room_full, room_not_found, ...)
    // plus per-room codes — see protocol.md's per-room "error codes" list
    ShowErrorToast(msg.message);
});

room.OnMessage<GameOverPayload>("game_over", (msg) => {
    ShowResultsScreen(msg);
});
```

Every `error` the server can send is enumerated in [protocol.md](protocol.md) (shared conventions + per-room sections) — handle all listed codes, don't just catch-all/log-and-ignore.

## 8. Disconnect / reconnect

Server uses Colyseus's built-in `allowReconnection` (see [protocol.md](protocol.md) shared conventions) — on unexpected disconnect, the Unity client should attempt `client.Reconnect(reconnectionToken)` within the server's allowed window rather than immediately dropping the player back to the lobby/menu. Cache the reconnection token (`room.ReconnectionToken`) as soon as you get it after join, since it's needed for the reconnect call.

## 9. Leaving a room

Call `room.Leave()` on explicit "return to lobby"/"quit" actions — don't just destroy the scene/GameObject and let the connection time out, since that delays the server's cleanup (`onLeave`) and idle-room detection (see [architecture.md](architecture.md)).

## Open items (not yet resolved — don't guess)

- Exact final room name strings and per-game state schema class names/fields beyond what's drafted in [protocol.md](protocol.md) — still TBD pending room implementation. (The production domain is settled: `api.museum.fajrsyauqi.com`, see §2.) Check `protocol.md` and `dev-plan.md` for current status before hardcoding anything here.

## Client status (as built)

The Unity client is wired to this server, not to a mock:

- **Schema**: `Assets/Scripts/Net/Schema/*.cs` is generated from `src/rooms/schema/*.ts`
  with `schema-codegen` (namespace `Museum.Net.State`). Regenerate on any schema change —
  the decoder addresses fields by index, so a drift shows as garbled state, not an error.
- **Lobby**: `ColyseusLobbyService` creates private rooms / joins by code, renders the
  base lobby fields, and sends `start_game`. Rejections arrive as `error` messages.
- **Handoff**: the lobby releases its room *unconsented* (`ReleaseForHandoff`) before the
  game scene loads, so the seat sits in `allowReconnection` instead of looking like a
  walkout; the game scene reconnects with the token cached in `SessionData`. Without that
  release, the dying lobby socket ends the match for everyone else.
- **Dakon**: `NetDakonSession` renders `DakonState` and sends `drop_seed`; nothing is drawn
  optimistically, so the board always matches the server.
- **Identity**: the client sends `playerId`, a GUID it mints into PlayerPrefs. Stats only —
  see [database.md](database.md).
