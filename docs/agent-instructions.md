# Agent Instructions

For any agent (Claude Code or otherwise) working in this repo.

## Before starting work

Read the relevant doc(s) in this folder first: [overview.md](overview.md) for what the project is, [tech-stack.md](tech-stack.md) for what's already decided, [architecture.md](architecture.md) for how pieces fit together, [boundaries.md](boundaries.md) for what not to do. If working on a specific minigame's room logic, also read its rules doc in [games/](games/) and its section in [protocol.md](protocol.md) first — **do not invent game rules or message shapes; if a `games/*.md` file is still `TODO`, stop and ask for the rules rather than guessing.** Don't re-derive decisions already made here.

## While/after making changes

Update the relevant doc in this folder whenever a change alters what it describes:

- New room/game added → note it in `overview.md` and `architecture.md`.
- Game rules received/changed → fill in / update the matching `games/*.md` file.
- Message/state shape decided or changed → update the matching room section in `protocol.md`.
- Stack/dependency change → `tech-stack.md`.
- New deployment target, hosting change, scaling change → `architecture.md`.
- New constraint discovered, or a boundary deliberately relaxed by user decision → `boundaries.md`.

Keep docs in sync with code — a doc describing something that no longer exists is worse than no doc. If unsure whether a change is doc-worthy, prefer a short update over none.

## Conventions to follow

See `tech-stack.md` and `architecture.md` for specifics (ESM import extensions, server-authoritative state, one Room class per game, ports/scripts). Don't repeat those here — this file is about process, not stack facts.
