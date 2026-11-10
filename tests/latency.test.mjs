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
