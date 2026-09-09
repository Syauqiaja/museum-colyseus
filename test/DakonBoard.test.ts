import assert from "assert";
import { DakonBoard } from "../src/games/dakon/DakonBoard.js";
import { DAKON_HOLE_TYPES } from "../src/games/dakon/DakonConfig.js";

/**
 * Rules-only tests: no server, no room. These pin the v6 ruleset the client's
 * DakonBoard.cs implements — if one of these changes, the two implementations have
 * drifted and the client will render a board the server does not have.
 */
describe("DakonBoard — v6 rules", () => {
  /** Play the whole hand into the forced holes, choosing seeds by a picker. */
  function playHand(board: DakonBoard, pick: (hand: readonly { id: string }[]) => string) {
    const drops: ReturnType<DakonBoard["drop"]>[] = [];

    while (board.currentHand.length > 0) {
      const seat = board.activePlayer;
      const before = board.currentHand.length;
      const result = board.drop(seat, pick(board.currentHand), board.nextHoleIndex);

      assert.ok(result.ok, `drop rejected: ${result.error}`);
      drops.push(result);

      if (result.turnEnded) break;
      assert.strictEqual(board.currentHand.length, before - 1);
    }

    return drops;
  }

  it("starts with a full board, seat 0 to act at hole 0", () => {
    const board = new DakonBoard(1);
    board.start();

    assert.strictEqual(board.phase, "in_progress");
    assert.strictEqual(board.holeCount, 20);
    assert.strictEqual(board.activePlayer, 0);
    assert.strictEqual(board.nextHoleIndex, 0);
    assert.strictEqual(board.currentHand.length, 15);
    assert.strictEqual(board.poolCount, 60 - 15);
  });

  it("gives each side exactly 5 dicot holes of 10", () => {
    const board = new DakonBoard(7);
    board.start();

    for (const side of [0, 1]) {
      const types = board.holeTypes.slice(side * 10, side * 10 + 10);
      assert.strictEqual(types.filter((t) => t === "dicot").length, 5);
      assert.strictEqual(types.filter((t) => t === "monocot").length, 5);
    }
  });

  // The layout is pinned to the icons painted on the client's board, so it is the
  // same board every match — and the same board on both sides of the wire. A rolled
  // layout would pass the 5/5 test above and still contradict the picture.
  it("lays the holes out exactly as DAKON_HOLE_TYPES, whatever the seed", () => {
    for (const seed of [1, 7, 42, 9999]) {
      const board = new DakonBoard(seed);
      board.start();

      assert.deepStrictEqual(
        board.holeTypes,
        DAKON_HOLE_TYPES,
        `seed ${seed} rolled a layout instead of using the painted one`,
      );
    }
  });

  it("copies the layout, so no board holds the shared array itself", () => {
    const board = new DakonBoard(1);
    board.start();

    assert.notStrictEqual(
      board.holeTypes,
      DAKON_HOLE_TYPES,
      "a board aliasing the config could retype every future match",
    );
  });

  it("a match scores the dropper, a mismatch scores the opponent", () => {
    const board = new DakonBoard(3);
    board.start();

    const holeType = board.holeTypes[board.nextHoleIndex];
    const matching = board.currentHand.find((s) => s.category === holeType);
    const clashing = board.currentHand.find((s) => s.category !== holeType);
    assert.ok(matching && clashing, "hand of 15 should contain both categories");

    const match = board.drop(0, matching!.id, board.nextHoleIndex);
    assert.deepStrictEqual(
      { ok: match.ok, wasMatch: match.wasMatch, scoringPlayer: match.scoringPlayer },
      { ok: true, wasMatch: true, scoringPlayer: 0 },
    );
    assert.strictEqual(board.total(0), 1);

    // Second hole: force a mismatch against *its* type.
    const nextType = board.holeTypes[board.nextHoleIndex];
    const wrong = board.currentHand.find((s) => s.category !== nextType);
    assert.ok(wrong, "a wrong-category seed should still be in hand");

    const mismatch = board.drop(0, wrong!.id, board.nextHoleIndex);
    assert.strictEqual(mismatch.wasMatch, false);
    assert.strictEqual(mismatch.scoringPlayer, 1);
    assert.strictEqual(board.total(1), 1);
  });

  it("rejects the wrong player, the wrong hole, and a seed not in hand", () => {
    const board = new DakonBoard(11);
    board.start();

    const seed = board.currentHand[0].id;

    assert.strictEqual(board.drop(1, seed, board.nextHoleIndex).error, "not_your_turn");
    assert.strictEqual(board.drop(0, seed, board.nextHoleIndex + 3).error, "invalid_hole");
    assert.strictEqual(board.drop(0, "no-such-seed", board.nextHoleIndex).error, "seed_not_in_hand");

    // All three were rejections, so nothing moved.
    assert.strictEqual(board.currentHand.length, 15);
    assert.strictEqual(board.total(0) + board.total(1), 0);
  });

  it("a 15-seed hand wraps past the sower's own 10 holes onto the opponent's side", () => {
    const board = new DakonBoard(5);
    board.start();

    const visited: number[] = [];
    while (board.currentHand.length > 0) {
      visited.push(board.nextHoleIndex);
      const result = board.drop(0, board.currentHand[0].id, board.nextHoleIndex);
      assert.ok(result.ok);
      if (result.turnEnded) break;
    }

    assert.deepStrictEqual(visited.slice(0, 10), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.deepStrictEqual(visited.slice(10), [10, 11, 12, 13, 14], "spills onto seat 1's side");
  });

  it("hands the turn over and re-draws when the hand empties", () => {
    const board = new DakonBoard(13);
    board.start();

    const drops = playHand(board, (hand) => hand[0].id);

    assert.strictEqual(drops.at(-1)!.turnEnded, true);
    assert.strictEqual(drops.at(-1)!.gameOver, false);
    assert.strictEqual(board.activePlayer, 1, "turn passes");
    assert.strictEqual(board.nextHoleIndex, 10, "seat 1 starts from its own side");
    assert.strictEqual(board.currentHand.length, 15, "fresh hand drawn");
    assert.strictEqual(board.poolCount, 60 - 30);
  });

  it("plays out: 4 hands of 15 exhaust the pool, then the game is over and scored", () => {
    const board = new DakonBoard(17);
    board.start();

    let hands = 0;
    while (board.phase === "in_progress") {
      playHand(board, (hand) => hand[0].id);
      hands++;
      assert.ok(hands <= 6, "should not need more than 4 hands");
    }

    assert.strictEqual(hands, 4);
    assert.strictEqual(board.phase, "finished");
    assert.strictEqual(board.poolCount, 0);
    assert.strictEqual(board.total(0) + board.total(1), 60, "every seed is scored to someone");

    const winner = board.winner;
    const [a, b] = [board.total(0), board.total(1)];
    assert.strictEqual(winner, a === b ? null : a > b ? 0 : 1);
  });

  it("a short final draw ends the game when the pool runs dry", () => {
    // 20 seeds, 15 per grab → second hand is 5 long and finishes the game.
    const board = new DakonBoard(23, { poolSeeds: 20 });
    board.start();

    playHand(board, (hand) => hand[0].id);
    assert.strictEqual(board.currentHand.length, 5, "partial final hand");
    assert.strictEqual(board.poolCount, 0);

    const last = playHand(board, (hand) => hand[0].id).at(-1)!;
    assert.strictEqual(last.gameOver, true);
    assert.strictEqual(board.phase, "finished");
    assert.strictEqual(board.total(0) + board.total(1), 20);
  });

  it("rejects any drop once the game is finished", () => {
    const board = new DakonBoard(29, { poolSeeds: 15 });
    board.start();
    playHand(board, (hand) => hand[0].id);

    assert.strictEqual(board.phase, "finished");
    assert.strictEqual(board.drop(0, "s0", board.nextHoleIndex).ok, false);
  });

  // The seed decides the deal, not the board. The hole layout used to vary with it and
  // no longer does — it is pinned to the artwork — so the "different across seeds" half
  // of this now belongs to the hand.
  it("is deterministic for a given seed, and different across seeds", () => {
    const a = new DakonBoard(99);
    const b = new DakonBoard(99);
    const c = new DakonBoard(100);
    a.start();
    b.start();
    c.start();

    assert.deepStrictEqual([...a.holeTypes], [...b.holeTypes]);
    assert.deepStrictEqual(
      a.currentHand.map((s) => s.id),
      b.currentHand.map((s) => s.id),
    );
    assert.notDeepStrictEqual(
      a.currentHand.map((s) => s.id),
      c.currentHand.map((s) => s.id),
    );
    assert.deepStrictEqual(
      [...a.holeTypes],
      [...c.holeTypes],
      "the board is the same every match, whatever the seed",
    );
  });
});
