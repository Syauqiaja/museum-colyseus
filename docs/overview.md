# Overview

Backend for a browser-playable Unity WebGL experience shown at museum kiosks (and publicly on the web, same server). The Unity frontend has **4 scenes**: one single-player exhibition hub and three multiplayer minigames launched from it. Players create or join a minigame room by short code; many rooms run concurrently, fully isolated from each other. The create/join-public/join-by-code matchmaking is a shared, reusable layer (`BaseGameRoom`) — see [room-system.md](room-system.md).

## Scenes

- **Virtual Exhibition Museum** — entry point / main menu. Single-player: the player just walks around and picks a minigame to launch. **Not multiplayer.**
  Assumption (unconfirmed): this scene needs no Colyseus room at all — purely client-side navigation. Revisit if the hub ever needs shared/visible avatars.
- **Dakon** (Congklak) — multiplayer, **complete**: room, matchmaking, the v6 move engine (`src/games/dakon/DakonBoard.ts`), scoring and `game_over`. Rules: see [games/dakon.md](games/dakon.md).
- **Engklak** (hopscotch-style) — multiplayer. Rules: see [games/engklak.md](games/engklak.md) (pending — to be supplied).
- **Egrang** (stilt-walking race) — multiplayer. `EgrangRoom` seats 3 and the host starts at 2, but **the race itself is not implemented**: rules are still pending. See [games/egrang.md](games/egrang.md).

All three minigames are expected to fit comfortably on plain WebSockets — no need for WebRTC or a heavyweight engine like Photon/NGO (see [tech-stack.md](tech-stack.md)).

## Who it's for

- Museum kiosks: same public URL, opened full-screen in a kiosk-mode browser (e.g. Chrome `--kiosk`). Just need internet access at the venue.
- Public/home players: same server, same URL.

See [dev-plan.md](dev-plan.md) for full rationale, timeline, and cost breakdown (written before Engklak and the exhibition hub were scoped in — treat it as historical/networking rationale, not the current game list).
