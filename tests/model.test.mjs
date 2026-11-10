import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const M = createRequire(import.meta.url)("../site/model.js");

const logs = (vals, extra = {}) => vals.map((v, i) => ({ date: new Date(Date.UTC(2026, 10, 30 - i * 2)).toISOString().slice(0, 10), home: i % 2 === 0, min: 34, stats: { pts: v, fg3: Math.round(v / 10) }, ...extra }));

test("odds helpers and Kelly", () => {
  assert.equal(M.toAmerican(0.5), -100); assert.equal(M.toAmerican(0.25), 300);
  assert.ok(Math.abs(M.ev(0.55, -110) - (0.55 * (100 / 110) - 0.45)) < 1e-9);
  assert.equal(M.kelly(0.4, -110), 0);
  assert.ok(Math.abs(M.kelly(0.6, 100) - 0.2) < 1e-9);
});

test("distributions", () => {
  assert.ok(Math.abs(M.probOver(25, 6, 25, "normal") - 0.5) < 0.01);
  assert.ok(M.probOver(30, 6, 24.5, "normal") > 0.8);
  assert.ok(Math.abs(M.probOver(2, 0, 1.5, "poisson") - (1 - Math.exp(-2) * 3)) < 1e-9); // P(X≥2) for λ=2
});

test("projection: recent form, teammate out, matchup and blowout factors", () => {
  const p = { logs: logs([30, 30, 30, 30, 30, 20, 20, 20, 20, 20]), home: true, opp: "BOS", restDays: 1,
    dvp: { group: "G", rank: { pts: 28 }, of: 30, factor: { pts: 1.15 }, n: { pts: 40 } },
    withWithout: [{ teammate: "Star", status: "Out", gamesWith: 6, gamesWithout: 4, avgWith: { pts: 22 }, avgWithout: { pts: 28 } }],
    game: { teamSpread: -11 } };
  const base = M.project({ logs: p.logs }, "pts", "nba");
  assert.ok(base.mean > 25, "weighted toward recent 30s");
  const full = M.project(p, "pts", "nba");
  const keys = full.parts.map(x => x.key);
  assert.ok(keys.includes("matchup") && keys.includes("teammate") && keys.includes("blowout"));
  assert.ok(full.mean > base.mean, "soft matchup + teammate out outweigh blowout risk");
  assert.equal(full.dist, "normal");
});

test("probabilities blend model and history; best bet across quotes", () => {
  const p = { logs: logs(Array(20).fill(30)), lines: { pts: 24.5 }, market: { pts: [
    { b: "DraftKings", l: 24.5, o: -120, u: 100 }, { b: "Kalshi", l: 27.5, o: 110, u: -130 } ] } };
  const r = M.bestBet(p, "pts", "nba");
  assert.ok(r.probs.over > 0.8);
  assert.equal(r.best.side, "over"); assert.ok(r.best.ev > 0);
  assert.ok(r.fairOver < -200);
});

test("rest splits and correlation", () => {
  const L = [{ date: "2026-11-10", stats: { pts: 10 } }, { date: "2026-11-09", stats: { pts: 30 } }, { date: "2026-11-06", stats: { pts: 20 } }];
  const r = M.restSplits(L, "pts", 15);
  assert.equal(r.b2b.n, 1); assert.equal(r.b2b.avg, 10); assert.equal(r.rested.n, 1);
  const A = Array.from({ length: 10 }, (_, i) => ({ date: `2026-10-${10 + i}`, stats: { pts: i % 2 ? 30 : 10 } }));
  const B = Array.from({ length: 10 }, (_, i) => ({ date: `2026-10-${10 + i}`, stats: { ast: i % 2 ? 9 : 3 } }));
  const c = M.correlation(A, "pts", 20.5, B, "ast", 5.5);
  assert.equal(c.n, 10); assert.ok(Math.abs(c.phi - 1) < 1e-9); assert.equal(c.both, 0.5);
  assert.equal(M.correlation(A.slice(0, 3), "pts", 1, B, "ast", 1), null);
});

test("bet settlement and closing-line value", () => {
  const bet = { stat: "pts", side: "over", line: 24.5, price: -110, stake: 11, gameDate: "2026-11-11T00:30:00Z" };
  assert.deepEqual(M.settle(bet, [{ date: "2026-11-11", stats: { pts: 30 } }]), { actual: 30, result: "won", pnl: 10 });
  assert.equal(M.settle({ ...bet, line: 30 }, [{ date: "2026-11-11", stats: { pts: 30 } }]).result, "push");
  assert.equal(M.settle(bet, []), null);
  const c = M.clv({ ...bet, close: { price: -130, line: 25.5 } });
  assert.ok(c.prob > 0); assert.equal(c.line, 1);
});
