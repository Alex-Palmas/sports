import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { findArbs, dec } = createRequire(import.meta.url)("../site/arb.js");

const data = (market, logs = []) => ({ sports: { nba: { name: "NBA", stats: [{ key: "pts", label: "Points" }], players: [{ id: "p1", name: "A B", team: "X", opp: "Y", logs, market: { pts: market } }] } } });

test("finds a same-line arb across books with correct stakes", () => {
  const [a] = findArbs(data([{ b: "DraftKings", l: 24.5, o: +110, u: -140 }, { b: "FanDuel", l: 24.5, o: -140, u: +110 }]));
  assert.ok(a, "arb found");
  assert.equal(a.over.b, "DraftKings"); assert.equal(a.under.b, "FanDuel");
  assert.ok(Math.abs(a.margin - 0.05) < 1e-9);                     // 2.10 both sides → 5% profit
  assert.ok(Math.abs(100 * a.wO * dec(a.over.o) - 100 * a.wU * dec(a.under.u)) < 1e-9); // equal payout
  assert.equal(a.middle, false);
});

test("no arb when both sides are vigged", () => {
  assert.equal(findArbs(data([{ b: "DK", l: 24.5, o: -110, u: -110 }, { b: "FD", l: 24.5, o: -110, u: -110 }])).length, 0);
});

test("middle: over at lower line, under at higher line", () => {
  const logs = [{ stats: { pts: 25 } }, { stats: { pts: 30 } }];
  const [a] = findArbs(data([{ b: "DK", l: 23.5, o: -105, u: -115 }, { b: "FD", l: 26.5, o: -125, u: -105 }], logs), { minMargin: -0.05 });
  assert.ok(a.middle); assert.equal(a.over.l, 23.5); assert.equal(a.under.l, 26.5);
  assert.equal(a.hitMiddle, 0.5);
});

test("over line above under line is never paired", () => {
  assert.equal(findArbs(data([{ b: "DK", l: 26.5, o: +300 }, { b: "FD", l: 23.5, u: +300 }]), { minMargin: -1 }).length, 0);
});
