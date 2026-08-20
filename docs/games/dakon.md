# Dakon — Rules

**Dakon Edukasi: Digital Edition (Monokotil vs. Dikotil)** — the **v6 ruleset**.

Contract note: rules below are ground truth for room logic. Message/state contract:
[../protocol.md](../protocol.md#dakon). Server implementation:
`src/games/dakon/DakonBoard.ts` (rules) + `src/rooms/DakonRoom.ts` (wire).

> **Two implementations, one ruleset.** The Unity client's
> `Assets/Scripts/Games/Dakon/DakonBoard.cs` implements the same rules for its
> offline/hotseat mode, and the server engine is a port of it. Change one, change the
> other — the server is authoritative, so a divergence shows up as a client rendering
> a board the server does not have. (An earlier draft of this doc described a
> different board: 24 holes, strictly alternating types, 10-seed draws, own-side
> sowing. That was never implemented on either side and has been dropped. A later
> draft of *this* board also said 120 seeds and 8 hands; the pool has always been 60
> in `DakonConfig.ts`, `DakonConfig.cs` and every test — 4 hands, 2 turns each.)

## Objective

Score the most points by dropping seeds into holes whose type matches the seed's
category (Monokotil or Dikotil). Most seeds in your storehouse at the end wins.

## Board setup

- **Centre pool:** 60 seeds — 30 monocot and 30 dicot (an odd pool would give the
  extra seed to monocot). `DAKON_DEFAULTS.poolSeeds`.
- **20 holes, 10 per player side.** Each side gets exactly 5 dicot and 5 monocot
  holes, **shuffled independently per side** — the sides are not mirrored, and the
  layout is fixed for the match. Holes are typed by category, never by species.
- **2 storehouses**, one per player, each split monocot/dicot for display.
- **Seed species** are cosmetic; category is what scores. A monocot hole accepts any
  monocot species. Species ids are the client's `SeedType` asset names.

## Turn order

1. **Draw (automatic):** at the start of a turn the server draws 15 random seeds from
   the pool into the active player's hand — or everything left, if fewer remain.
2. **Sowing:** one seed per hole into consecutive holes, starting at the player's own
   first hole (seat 0 → hole 0, seat 1 → hole 10) and advancing by one, wrapping
   around the ring. A full 15-seed hand therefore covers the player's own 10 holes
   **and spills onto the first 5 holes of the opponent's side** — that is intended.
3. The player chooses *which* held seed goes into each forced hole. The hole is not a
   choice; the seed is.
4. Sowing is sequential: drop, server validates and sweeps, then the next drop.

## Sowing / capture ("the Sweep")

Each hole is scored and cleared immediately after a seed lands in it:

| Action | Points | Seed destination |
|---|---|---|
| Match — seed category equals hole type | +1 active player | active player's storehouse |
| Mismatch — categories differ | +1 opponent | opponent's storehouse |

Holes hold no state between drops. Every seed ends in someone's storehouse, so the
two storehouses always sum to 60 at the end.

## Win condition

The game ends when the centre pool is exhausted and the final hand is sown — 4 hands
of 15, two turns each. Winner = larger storehouse total. A tie is possible and valid
(`winner: null`).

## Edge cases

- **Short final draw:** fewer than 15 seeds left → the hand is whatever remains, and
  the game ends once it is sown.
- **Invalid move:** a hole other than the forced next one, a seed not in hand, or a
  move by the waiting player is rejected with an `error` and changes nothing.
- **Disconnect/reconnect:** hand and sow position are server state and survive a
  reconnect inside the window (30s, `BaseGameRoom`).
- **Walkout:** a player leaving mid-match ends it; the remaining player is recorded as
  winning by forfeit and both clients receive `game_over`.
