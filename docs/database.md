# Database — MySQL

What the server persists, where, and the rules that go with holding it.

## Why there is one

Match results, player profiles and a live view of who is sitting where. Everything
else (board state, hands, turn) stays in the room's memory — it is worthless once
the match ends and would only slow the game down.

**Persistence never blocks gameplay.** Every write goes through `withDb()`
(`src/db/pool.ts`), which swallows and logs failures. A museum kiosk with a dead
database still plays; it just loses rows. Nothing in a room's lifecycle awaits a
query result before continuing.

## Setup

```bash
npm run db:migrate      # creates the database if needed, applies db/migrations/*.sql
npm start
```

Config comes from the environment (defaults in brackets):
`DB_HOST` [127.0.0.1], `DB_PORT` [3306], `DB_USER` [root], `DB_PASSWORD` [empty],
`DB_NAME` [museum_minigames], `DB_POOL_SIZE` [10], `DB_CONNECT_TIMEOUT_MS` [5000].
`DB_DISABLED=1` turns persistence off entirely — for a venue running without a
database, and for the default test run.

**Do not commit credentials.** Production values belong in the deployment's
environment, not in `.env.production`.

## Tables

| Table | Row per | Lifetime |
|---|---|---|
| `players` | stable client GUID | permanent (see retention) |
| `matches` | match | permanent |
| `match_players` | seat in a match | with its match (`ON DELETE CASCADE`) |
| `live_sessions` | connected socket | wiped on server boot |

Migrations are forward-only plain SQL in `db/migrations/`, applied once each and
recorded in `schema_migrations` by `db/migrate.ts`. No ORM: the schema is four
tables and a VPS should be able to migrate with nothing extra installed.

## Identity

`players.player_id` is a **GUID the Unity client mints and keeps in PlayerPrefs**,
sent as the `playerId` join option. It is what makes "games played" survive a
refresh.

It is **not a credential**. A client can clear or forge it, so it decides only
which stats row is incremented — never who may act in a room. Authorisation is
always the Colyseus `sessionId`, which the server issues per connection. A
malformed or missing `playerId` is dropped (`sanitizePlayerId`), and the player
still plays; their result row simply has a `NULL` `player_id`.

The GUID is deliberately kept off the synced schema: peers have no reason to read
each other's profile id.

## Privacy and retention

The only personal data here is a nickname a visitor typed (≤16 chars, validated
client-side) plus timestamps. No email, no age, no free text, no IP address.

Rules for anyone extending this:

- **Don't add fields that identify a real person** (email, phone, photo, exact
  age) without a decision recorded in `boundaries.md` — a museum exhibit does not
  need them.
- **Nicknames are shown as typed.** They are not moderated; treat them as
  untrusted display strings everywhere.
- **Retention:** profiles and matches are kept indefinitely today because nothing
  purges them. If this ships to a venue with a retention policy, add a scheduled
  delete of rows older than the agreed window — `players.last_seen_at` and
  `matches.started_at` are indexed for exactly that.

## What is written when

| Event | Effect |
|---|---|
| `onJoin` | upsert `players` (nickname, last seen); insert `live_sessions` row |
| drop / reconnect | `live_sessions.connected` toggled |
| match starts | `matches` row `in_progress` + `match_players` seats |
| match ends (pool exhausted) | `matches` → `completed`, final scores, winner; profile totals |
| player leaves mid-match | `matches` → `forfeited` (one player left) or `abandoned` |
| `onLeave` / room disposed | `live_sessions` rows removed |
| server boot | `live_sessions` truncated (`beforeListen`) |

Scores written are the **server's own** numbers, read from the room's authoritative
state — never a value a client reported.

## Tests

`npm test` runs with `DB_DISABLED=1` and touches no database.
`npm run test:db` runs `test/db/*.test.ts` against a real MySQL and reads the rows
back — necessary precisely because every write is fire-and-forget and would
otherwise be able to silently do nothing. It skips itself if no server is reachable.
