import test from "node:test";
import assert from "node:assert/strict";
import { eventSuffix, measureCrossing, measureScoreReaction, espnIncrements, median, stateAt } from "../scripts/kalshi-latency.mjs";

test("Kalshi event suffix uses the US-Eastern date and NBA tricodes", () => {
  assert.equal(eventSuffix("2026-11-11T00:30:00Z", "BOS", "PHI"), "26NOV10BOSPHI"); // 7:30pm ET on Nov 10
  assert.equal(eventSuffix("2026-11-11T03:00:00Z", "GS", "UTAH"), "26NOV10GSWUTA");
  assert.equal(eventSuffix("2026-11-13T01:00:00Z", "SA", "NY"), "26NOV12SASNYK");
});

test("ESPN plays become stat increments", () => {
  const three = { scoringPlay: true, scoreValue: 3, type: { text: "Pullup Jump Shot" }, participants: [{ athlete: { id: "1" } }, { athlete: { id: "2" } }] };
  assert.deepEqual(espnIncrements(three), [{ id: "1", stat: "pts", n: 3 }, { id: "1", stat: "fg3", n: 1 }, { id: "2", stat: "ast", n: 1 }]);
  const ft = { scoringPlay: true, scoreValue: 1, type: { text: "Free Throw - 1 of 2" }, participants: [{ athlete: { id: "1" } }] };
  assert.deepEqual(espnIncrements(ft), [{ id: "1", stat: "pts", n: 1 }]);
  assert.deepEqual(espnIncrements({ type: { text: "Defensive Rebound" }, participants: [{ athlete: { id: "3" } }] }), [{ id: "3", stat: "reb", n: 1 }]);
  assert.deepEqual(espnIncrements({ type: { text: "Defensive Team Rebound" }, participants: [] }), []);
});

const T = 1_000_000;
test("crossing where the feed beat Kalshi: stale ask and edge", () => {
  const tl = [{ t: T - 60e3, bid: 0.40, ask: 0.45 }, { t: T + 9e3, bid: 0.95, ask: 0.99 }];
  const r = measureCrossing({ playT: T, seenT: T + 4e3 }, tl);
  assert.equal(r.feedDelay, 4); assert.equal(r.kalshiDelay, 9); assert.equal(r.feedFirst, true);
  assert.equal(r.askAtSeen, 0.45); assert.equal(r.staleEdge, +(1 - 0.45 - 0.02).toFixed(4));
});

test("crossing where Kalshi was faster than the feed", () => {
  const tl = [{ t: T - 60e3, bid: 0.40, ask: 0.45 }, { t: T + 2e3, bid: 0.93, ask: 0.97 }];
  const r = measureCrossing({ playT: T, seenT: T + 12e3 }, tl);
  assert.equal(r.kalshiDelay, 2); assert.equal(r.feedFirst, false); assert.equal(r.askAtSeen, 0.97);
});

test("market already priced in before the play is excluded", () => {
  assert.equal(measureCrossing({ playT: T, seenT: T + 1e3 }, [{ t: T - 5e3, bid: 0.92, ask: 0.95 }]).alreadyPriced, true);
});

test("closed market counts as Kalshi's adjustment", () => {
  const tl = [{ t: T - 60e3, bid: 0.5, ask: 0.55 }, { t: T + 6e3, bid: 1, ask: 1, closed: true }];
  assert.equal(measureCrossing({ playT: T, seenT: T + 3e3 }, tl).kalshiDelay, 6);
});

test("game-line reaction is the first price change after the play", () => {
  const a = [{ t: T - 30e3, bid: 0.5, ask: 0.52 }, { t: T + 3e3, bid: 0.55, ask: 0.57 }];
  const b = [{ t: T - 30e3, bid: 0.46, ask: 0.5 }, { t: T + 5e3, bid: 0.42, ask: 0.45 }];
  assert.equal(measureScoreReaction(T, [a, b]), 3);
  assert.equal(measureScoreReaction(T, [[{ t: T - 30e3, bid: 0.5, ask: 0.52 }]]), null);
});

test("helpers", () => {
  assert.equal(median([3, 1, 2]), 2); assert.equal(median([1, 2, 3, 4]), 2.5); assert.equal(median([null]), null);
  assert.equal(stateAt([{ t: 1, bid: 1 }, { t: 5, bid: 2 }], 4).bid, 1);
});

import { trajectory, medianCurve, midOf, OFFSETS } from "../scripts/kalshi-latency.mjs";

test("trajectory of a prop the play settled: start, 50%, 90%, steps, volume, left at feed time", () => {
  const P = 2_000_000;
  const tl = [
    { t: P - 60e3, bid: 0.40, ask: 0.44, vol: 1000 },   // pre mid 0.42
    { t: P + 3e3, bid: 0.55, ask: 0.61, vol: 1050 },     // first move
    { t: P + 6e3, bid: 0.70, ask: 0.76, vol: 1200 },     // 0.73 → 53% of the way to 1
    { t: P + 20e3, bid: 0.94, ask: 0.99, vol: 1500 },    // 0.965 → 94%
  ];
  const t = trajectory(tl, P, { final: 1, seenT: P + 5e3 });
  assert.equal(t.pre, 0.42); assert.equal(t.end, 1); assert.equal(t.move, 0.58);
  assert.equal(t.tStart, 3); assert.equal(t.t50, 6); assert.equal(t.t90, 20); assert.equal(t.steps, 3);
  assert.equal(t.traded, 500);
  // at feed time (+5s) mid was 0.58 → 0.16/0.58 done → 72% left
  assert.equal(t.leftAtSeen, +(1 - (0.58 - 0.42) / 0.58).toFixed(3));
  assert.equal(t.path[OFFSETS.indexOf(0)], 0.42); assert.equal(t.path[OFFSETS.indexOf(10)], 0.73);
  assert.equal(t.done[OFFSETS.indexOf(30)], +((0.965 - 0.42) / 0.58).toFixed(3));
});

test("game-line trajectory uses the price 120s later as the end; small moves are flat", () => {
  const P = 3_000_000;
  const tl = [{ t: P - 5e3, bid: 0.50, ask: 0.52 }, { t: P + 4e3, bid: 0.54, ask: 0.56 }, { t: P + 50e3, bid: 0.53, ask: 0.55 }];
  const t = trajectory(tl, P);
  assert.equal(t.pre, 0.51); assert.equal(t.end, 0.54); assert.equal(t.move, 0.03);
  assert.equal(t.tStart, 4); assert.equal(t.t50, 4); assert.equal(t.t90, 4);   // overshoot then settles
  assert.equal(trajectory([{ t: P - 5e3, bid: 0.5, ask: 0.52 }, { t: P + 4e3, bid: 0.505, ask: 0.52 }], P).flat, true);
  assert.equal(trajectory([], P), null);
});

test("closed market counts as probability 1; median curve", () => {
  assert.equal(midOf({ closed: true, bid: 1, ask: 1 }), 1);
  assert.equal(midOf({ bid: 0.4, ask: null }), 0.4);
  const c = medianCurve([{ done: OFFSETS.map(() => 0.2) }, { done: OFFSETS.map(() => 0.6) }, { done: OFFSETS.map(() => 1) }]);
  assert.equal(c.length, OFFSETS.length); assert.equal(c[0], 0.6);
});

import { windowFor } from "../scripts/kalshi-latency.mjs";
test("game-line window stops before the next scoring play", () => {
  assert.equal(windowFor(0, null), 120); assert.equal(windowFor(0, 25e3), 24); assert.equal(windowFor(0, 1e3), 3); assert.equal(windowFor(0, 500e3), 120);
  const P = 4_000_000;
  const t = trajectory([{ t: P - 5e3, bid: 0.5, ask: 0.52 }, { t: P + 3e3, bid: 0.55, ask: 0.57 }, { t: P + 40e3, bid: 0.30, ask: 0.32 }], P, { window: 20 });
  assert.equal(t.end, 0.56); assert.equal(t.path[OFFSETS.indexOf(30)], null);
});
