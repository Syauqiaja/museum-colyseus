# Egrang — stilt race

Three players race on stilts down parallel 25 m lanes. Rules below are the ground
truth for `EgrangRoom`; the Unity client implements the same numbers.

## Objective

First racer to cover the lane wins, and winning ends the race for everyone.

## Track setup

Three lanes, one per seat, identical in length. Distance is counted in **strides**,
not meters: one stride is 0.5 m on the client, and the race is `finishUnits = 50`
strides (25 m). The server never sees world coordinates.

## Real-time rules

A racer walks by timing presses against a sweeping skill-check bar. Each press
scores one of three outcomes, worth a fixed number of strides:

| Outcome | Value | Strides |
|---------|-------|---------|
| Fail    | 0     | 0 — stumbles in place |
| Half    | 1     | 1 |
| Full    | 2     | 2 |

Each player picks one of three stilts, which changes only how hard the timing is
(green-zone width and sweep speed): `0` persegi, `1` lingkaran, `2` segitiga. The
stilt does not change what a step is worth. The choice may be made while waiting
and stays open into the race itself, right up until that racer's first accepted
step — see "Player actions / inputs" below for why.

The match starts on a 15-second countdown: `startsAtMs` is stamped at game start and
no step counts before it. That window is the stilt-picking window, not a "get ready"
beat — the room auto-starts the moment it fills, usually before a client has finished
loading the Egrang scene, so it is the only time anyone gets to look at the three
poles. Clients show the countdown and take the highlighted pole automatically when it
runs out.

Because `startsAtMs` is a server wall-clock stamp, clients are not asked to subtract
their own clock from it: the remaining milliseconds are computed server-side and sent.

## Player actions / inputs

- `choose_stick { shape }` — while waiting, and into the race for a racer that
  hasn't stepped yet. The room auto-starts the moment its third seat fills, which
  is typically before the Unity client has even loaded the Egrang scene where the
  stilt picker lives — so in practice most `choose_stick` messages arrive after
  `phase` is already `in_progress`. It locks the instant that racer banks its
  first step (`stepUnits > 0` or `place > 0`), since only the difficulty of the
  choice — never the race — depends on it.
- `step { result }` during the race, one per press.
- `countdown_sync {}` — any time. The server replies to that client alone with
  `countdown { startsAtMs, remainingMs }`, where `remainingMs` is `0` outside a
  running countdown. The same payload is broadcast once at game start; the request
  exists because a client loading the scene (or reconnecting) normally misses it.

**The client grades its own press.** The bar's cursor sweeps a lap in 0.85–2.0 s, so
grading on arrival would turn a green press into a yellow one on any real
connection. The server instead bounds the *rate*: a press within 500 ms of the
previous accepted one is rejected. The bar's own lockout is 600 ms and a full step's
animation runs 1.12 s, so no honest press is ever refused. Every number that decides
the race — banked strides, places, winner, persisted score — is the server's.

## Win condition

Reaching 50 strides takes the next free place (1, then 2, then 3). The match ends
the moment place 1 is taken — nobody is kept waiting on a lane they cannot win —
or when every racer is placed, which a three-way race can reach on a later step
than the winner's. Unplaced racers keep `place = 0` and their banked strides,
which is their score.

## Edge cases

- A step before `startsAtMs`, from an unseated client, with an out-of-range result,
  or from a racer already placed: rejected with `invalid_move`, no state change.
- A `choose_stick` once the race is over, or once that racer has banked a step:
  rejected with `invalid_move`, the stored stilt unchanged.
- Banked strides clamp at `finishUnits`; a Full step across the line is not overshot.
- A racer who leaves mid-race stops sending steps. The base class's forfeit
  bookkeeping applies and the first survivor home ends the race for the rest.
- Reconnect: `stepUnits` is synced state, so a returning client places its racer
  from it rather than replaying steps.
