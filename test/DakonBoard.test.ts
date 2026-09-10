import assert from "assert";
import { DakonBoard } from "../src/games/dakon/DakonBoard.js";
import { DAKON_HOLE_TYPES, DAKON_DEFAULTS } from "../src/games/dakon/DakonConfig.js";

/**
 * Rules-only tests: no server, no room. These pin the v7 ruleset the client's
 * DakonBoard.cs implements — if one of these changes, the two implementations have
 * drifted and the client will render a board the server does not have.
 */
describe("DakonBoard — v7 rules", () => {
  const SIDE = DAKON_DEFAULTS.holesPerSide;

  /** First hole on the active seat's side that has not taken a seed this turn. */
  function freeHole(board: DakonBoard): number {
    const lo = board.activePlayer * SIDE;
    for (let i = lo; i < lo + SIDE; i++) {
      if (!board.isSown(i)) return i;
    }
    assert.fail("no free hole on the active side");
  }

  /** Play the whole hand into the first free own hole each time, choosing seeds by a picker. */
  function playHand(board: DakonBoard, pick: (hand: readonly { id: string }[]) => string) {
    const drops: ReturnType<DakonBoard["drop"]>[] = [];

    while (board.currentHand.length > 0) {
      const seat = board.activePlayer;
      const before = board.currentHand.length;
      const result = board.drop(seat, pick(board.currentHand), freeHole(board));

      assert.ok(result.ok, `drop rejected: ${result.error}`);
      drops.push(result);

      if (result.turnEnded) break;
      assert.strictEqual(board.currentHand.length, before - 1);
    }

    return drops;
  }

  it("starts with a full board, seat 0 to act, nothing sown", () => {
    const board = new DakonBoard(1);
    board.start();

    assert.strictEqual(board.phase, "in_progress");
    assert.strictEqual(board.holeCount, 20);
    assert.strictEqual(board.activePlayer, 0);
    assert.strictEqual(board.sownMask, 0);
    assert.strictEqual(board.currentHand.length, 10);
    assert.strictEqual(board.poolCount, 60 - 10);
  });

  // A hand is exactly one side's worth of holes: that is what turns "place ten seeds"
  // into "fill your ten holes", and the only reason one-seed-per-hole can never leave a
  // player holding seeds with nowhere to put them.
  it("deals a hand the size of one side", () => {
    assert.strictEqual(DAKON_DEFAULTS.grabSize, DAKON_DEFAULTS.holesPerSide);
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

    const first = freeHole(board);
    const holeType = board.holeTypes[first];
    const matching = board.currentHand.find((s) => s.category === holeType);
    const clashing = board.currentHand.find((s) => s.category !== holeType);
    assert.ok(matching && clashing, "hand of 10 should contain both categories");

    const match = board.drop(0, matching!.id, first);
    assert.deepStrictEqual(
      { ok: match.ok, wasMatch: match.wasMatch, scoringPlayer: match.scoringPlayer },
      { ok: true, wasMatch: true, scoringPlayer: 0 },
    );
    assert.strictEqual(board.total(0), 1);

    // Another hole: force a mismatch against *its* type.
    const second = freeHole(board);
    const nextType = board.holeTypes[second];
    const wrong = board.currentHand.find((s) => s.category !== nextType);
    assert.ok(wrong, "a wrong-category seed should still be in hand");

    const mismatch = board.drop(0, wrong!.id, second);
    assert.strictEqual(mismatch.wasMatch, false);
    assert.strictEqual(mismatch.scoringPlayer, 1);
    assert.strictEqual(board.total(1), 1);
  });

  it("rejects the wrong player, the opponent's hole, a hole off the board, and a seed not in hand", () => {
    const board = new DakonBoard(11);
    board.start();

    const seed = board.currentHand[0].id;

    assert.strictEqual(board.drop(1, seed, 0).error, "not_your_turn");
    assert.strictEqual(board.drop(0, seed, SIDE).error, "invalid_hole");
    assert.strictEqual(board.drop(0, seed, -1).error, "invalid_hole");
    assert.strictEqual(board.drop(0, seed, 20).error, "invalid_hole");
    assert.strictEqual(board.drop(0, seed, 1.5).error, "invalid_hole");
    assert.strictEqual(board.drop(0, "no-such-seed", 0).error, "seed_not_in_hand");

    // All were rejections, so nothing moved — and no hole was marked.
    assert.strictEqual(board.currentHand.length, 10);
    assert.strictEqual(board.total(0) + board.total(1), 0);
    assert.strictEqual(board.sownMask, 0);
  });

  it("lets any own hole be chosen in any order", () => {
    const board = new DakonBoard(5);
    board.start();

    // Last hole of the side first, then the first: the order used to be forced.
    assert.ok(board.drop(0, board.currentHand[0].id, SIDE - 1).ok);
    assert.ok(board.drop(0, board.currentHand[0].id, 0).ok);

    assert.strictEqual(board.currentHand.length, 8);
    assert.strictEqual(board.sownMask, (1 << (SIDE - 1)) | 1);
  });

  it("refuses a second seed into the same hole in one turn", () => {
    const board = new DakonBoard(5);
    board.start();

    assert.ok(board.drop(0, board.currentHand[0].id, 4).ok);
    const result = board.drop(0, board.currentHand[0].id, 4);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "hole_already_sown");
    assert.strictEqual(board.currentHand.length, 9, "nothing moved");
  });

  it("hands the turn over, clears the sown set and re-draws when the hand empties", () => {
    const board = new DakonBoard(13);
    board.start();

    const drops = playHand(board, (hand) => hand[0].id);

    assert.strictEqual(drops.at(-1)!.turnEnded, true);
    assert.strictEqual(drops.at(-1)!.gameOver, false);
    assert.strictEqual(board.activePlayer, 1, "turn passes");
    assert.strictEqual(board.sownMask, 0, "a fresh turn has no sown holes");
    assert.strictEqual(board.currentHand.length, 10, "fresh hand drawn");
    assert.strictEqual(board.poolCount, 60 - 20);
  });

  it("seat 1 sows only the second side", () => {
    const board = new DakonBoard(13);
    board.start();
    playHand(board, (hand) => hand[0].id);

    assert.strictEqual(board.drop(1, board.currentHand[0].id, 0).error, "invalid_hole");
    assert.ok(board.drop(1, board.currentHand[0].id, 10).ok);
    assert.ok(board.drop(1, board.currentHand[0].id, 19).ok);
  });

  it("plays out: 6 hands of 10 exhaust the pool, then the game is over and scored", () => {
    const board = new DakonBoard(17);
    board.start();

    let hands = 0;
    while (board.phase === "in_progress") {
      playHand(board, (hand) => hand[0].id);
      hands++;
      assert.ok(hands <= 8, "should not need more than 6 hands");
    }

    assert.strictEqual(hands, 6);
    assert.strictEqual(board.phase, "finished");
    assert.strictEqual(board.poolCount, 0);
    assert.strictEqual(board.total(0) + board.total(1), 60, "every seed is scored to someone");

    const winner = board.winner;
    const [a, b] = [board.total(0), board.total(1)];
    assert.strictEqual(winner, a === b ? null : a > b ? 0 : 1);
  });

  it("a short final draw ends the game when the pool runs dry", () => {
    // 15 seeds, 10 per grab → second hand is 5 long and finishes the game.
    const board = new DakonBoard(23, { poolSeeds: 15 });
    board.start();

    playHand(board, (hand) => hand[0].id);
    assert.strictEqual(board.currentHand.length, 5, "partial final hand");
    assert.strictEqual(board.poolCount, 0);

    const last = playHand(board, (hand) => hand[0].id).at(-1)!;
    assert.strictEqual(last.gameOver, true);
    assert.strictEqual(board.phase, "finished");
    assert.strictEqual(board.total(0) + board.total(1), 15);
  });

  it("rejects any drop once the game is finished", () => {
    const board = new DakonBoard(29, { poolSeeds: 10 });
    board.start();
    playHand(board, (hand) => hand[0].id);

    assert.strictEqual(board.phase, "finished");
    assert.strictEqual(board.drop(0, "s0", 0).ok, false);
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
