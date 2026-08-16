# Docs Index

All project knowledge, decisions, and agent instructions live here. Read relevant docs before starting work; update them when a change alters what they describe (new room, changed stack decision, new boundary, new deployment target). Don't let this drift from reality — stale docs are worse than none.

- [overview.md](overview.md) — what this project is, the scenes/games, who it's for
- [tech-stack.md](tech-stack.md) — stack, versions, why each piece was chosen
- [architecture.md](architecture.md) — room system, networking model, deployment topology
- [room-system.md](room-system.md) — room management & matchmaking: the reusable `BaseGameRoom` (join flows, codes, lifecycle, reconnect); read before adding a game
- [protocol.md](protocol.md) — client↔server message/state contract, per room
- [database.md](database.md) — what MySQL stores (players, matches, live seats), setup, identity and privacy rules
- [deployment.md](deployment.md) — how to get this server **and the Unity WebGL build** onto one VPS: hostnames, build, PM2, env vars, nginx/TLS, exposed routes, redeploys
- [unity-integration.md](unity-integration.md) — how to wire the Unity client to this server (SDK, connect, join/create, state, messages, reconnect)
- [games/](games/) — per-game rules ground truth: [dakon.md](games/dakon.md), [engklak.md](games/engklak.md), [egrang.md](games/egrang.md) (rules still TODO — the Egrang **room** exists, the race does not)
- [boundaries.md](boundaries.md) — what's explicitly out of scope / not to introduce
- [agent-instructions.md](agent-instructions.md) — how an agent (Claude or otherwise) should work in this repo
- [dev-plan.md](dev-plan.md) — original full dev plan (phases, timeline, cost, risks) — historical/networking rationale; game list there is outdated, see overview.md for current scope
