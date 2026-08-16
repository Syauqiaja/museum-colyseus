import assert from "assert";
import { EgrangRace } from "../src/games/egrang/EgrangRace.js";

const START = 1_000_000;

function armed(sessions = ["a", "b", "c"]) {
  const race = new EgrangRace(sessions);
  race.arm(START);
  return race;
}

describe("EgrangRace", () => {
  it("banks 2 strides for a full step, 1 for half, 0 for fail", () => {
    const race = armed();

    assert.deepStrictEqual(race.step("a", 2, START), { ok: true, stepUnits: 2, place: 0 });
    assert.deepStrictEqual(race.step("a", 1, START + 600), { ok: true, stepUnits: 3, place: 0 });
    assert.deepStrictEqual(race.step("a", 0, START + 1200), { ok: true, stepUnits: 3, place: 0 });
  });

  it("rejects a step inside the 500 ms rate limit and banks nothing", () => {
    const race = armed();
    race.step("a", 2, START);

    assert.deepStrictEqual(race.step("a", 2, START + 499), { ok: false, reason: "too_soon" });
    assert.strictEqual(race.unitsOf("a"), 2);
  });

  it("rejects steps before the countdown, from strangers, and out of range", () => {
    const race = armed();

    assert.deepStrictEqual(race.step("a", 2, START - 1), { ok: false, reason: "not_started" });
    assert.deepStrictEqual(race.step("zz", 2, START), { ok: false, reason: "not_seated" });
    assert.deepStrictEqual(race.step("a", 7, START), { ok: false, reason: "bad_result" });
  });

  it("clamps at the finish and hands out places in finishing order", () => {
    const race = new EgrangRace(["a", "b", "c"], 4);
    race.arm(START);

    race.step("a", 2, START);
    assert.deepStrictEqual(race.step("a", 2, START + 600), { ok: true, stepUnits: 4, place: 1 });

    race.step("b", 2, START);
    race.step("b", 2, START + 600);
    assert.strictEqual(race.placeOf("b"), 2);

    assert.deepStrictEqual(race.step("a", 2, START + 1200), { ok: false, reason: "already_placed" });
    assert.strictEqual(race.unitsOf("a"), 4);
    assert.strictEqual(race.allPlaced, false);
    assert.strictEqual(race.winner, "a");
    assert.strictEqual(race.firstFinishMs, START + 600);
  });

  it("reports every racer's place, zero for the unfinished", () => {
    const race = new EgrangRace(["a", "b"], 2);
    race.arm(START);
    race.step("a", 2, START);

    assert.deepStrictEqual(race.places(), { a: 1, b: 0 });
    assert.strictEqual(race.allPlaced, false);
  });

  it("asserts allPlaced true when every seated racer has a place, and false for empty race", () => {
    // All racers placed
    const race = new EgrangRace(["a", "b"], 2);
    race.arm(START);
    race.step("a", 2, START);
    race.step("b", 2, START);
    assert.strictEqual(race.allPlaced, true);

    // Empty race is not "all placed"
    const emptyRace = new EgrangRace([]);
    assert.strictEqual(emptyRace.allPlaced, false);
  });

  it("excludes a withdrawn racer from allPlaced but keeps their place/units in places()", () => {
    const race = new EgrangRace(["a", "b", "c"], 2);
    race.arm(START);

    race.withdraw("c");
    assert.strictEqual(race.allPlaced, false);

    race.step("a", 2, START);
    assert.strictEqual(race.allPlaced, false);

    race.step("b", 2, START);
    assert.strictEqual(race.allPlaced, true);
    assert.deepStrictEqual(race.places(), { a: 1, b: 2, c: 0 });
  });

  it("withdrawing everyone leaves allPlaced false, not vacuously true", () => {
    const race = new EgrangRace(["a", "b"], 2);
    race.arm(START);

    race.withdraw("a");
    race.withdraw("b");
    assert.strictEqual(race.allPlaced, false);
  });

  it("accepts a step exactly 500 ms after the previous one", () => {
    const race = armed();
    race.step("a", 2, START);

    // Exactly 500 ms later should be accepted
    assert.deepStrictEqual(race.step("a", 2, START + 500), { ok: true, stepUnits: 4, place: 0 });
  });
});
