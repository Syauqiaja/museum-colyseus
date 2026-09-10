# Overview

Backend for a browser-playable Unity WebGL experience shown at museum kiosks (and publicly on the web, same server). The Unity frontend has **4 scenes**: one shared exhibition hub (visitors see each other walking it) and three multiplayer minigames launched from it. Players create or join a minigame room by short code; many rooms run concurrently, fully isolated from each other. The create/join-public/join-by-code matchmaking is a shared, reusable layer (`BaseGameRoom`) — see [room-system.md](room-system.md).

## Scenes

- **Virtual Exhibition Museum** — entry point / main menu. The player walks around and picks a minigame to launch. Not a game, but **shared**: the `museum` presence room (`src/rooms/MuseumRoom.ts`) syncs every visitor's position and name so they see each other in the hall. See [protocol.md](protocol.md#exhibition-museum-scene).
- **Dakon** (Congklak) — multiplayer, **complete**: room, matchmaking, the v6 move engine (`src/games/dakon/DakonBoard.ts`), scoring and `game_over`. Rules: see [games/dakon.md](games/dakon.md).
- **Engklak** (hopscotch-style) — multiplayer. Rules: see [games/engklak.md](games/engklak.md) (pending — to be supplied).
- **Egrang** (stilt-walking race) — multiplayer, **complete**: room, matchmaking, the race engine (`src/games/egrang/EgrangRace.ts`), the 15 s stilt-picking countdown, places and `game_over`. Seats 3, host may start at 2. Rules: see [games/egrang.md](games/egrang.md).

All three minigames are expected to fit comfortably on plain WebSockets — no need for WebRTC or a heavyweight engine like Photon/NGO (see [tech-stack.md](tech-stack.md)).

## Who it's for

- Museum kiosks: same public URL, opened full-screen in a kiosk-mode browser (e.g. Chrome `--kiosk`). Just need internet access at the venue.
- Public/home players: same server, same URL.

See [dev-plan.md](dev-plan.md) for full rationale, timeline, and cost breakdown (written before Engklak and the exhibition hub were scoped in — treat it as historical/networking rationale, not the current game list).
