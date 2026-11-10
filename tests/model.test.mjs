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
  assert.equal(full.dist, "skew");
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

test("negative binomial: matches Poisson at equal variance, survives large means, skews right", () => {
  assert.ok(Math.abs(M.countCdf(3, 2, 2) - M.poissonCdf(3, 2)) < 1e-12);
  const c = M.countCdf(250, 250, 70 * 70); // passing yards
  assert.ok(c > 0.45 && c < 0.6, String(c));
  // right skew: P(X > mean) under 50% for a wide count distribution
  assert.ok(1 - M.countCdf(25, 25, 100) < 0.5);
});

test("fitted settings stay inside sane bounds", () => {
  for (const lg of ["nba", "nfl", "nhl"]) {
    const c = M.cfg(lg);
    assert.ok(c.calA > 0.7 && c.calA < 1.3); assert.ok(c.marketWeight >= 0 && c.marketWeight <= 1);
    assert.ok(c.halfLife >= 3 && c.empWeight >= 0 && c.empWeight <= 0.5);
  }
});

test("confidence: clean prop is High; injury, thin market and big disagreement pull it down", () => {
  const L = Array.from({ length: 30 }, (_, i) => ({ date: `2026-10-${String(30 - i).padStart(2, "0")}`, season: "s", min: 32, stats: { pts: 20 + (i % 5) } }));
  const p = { logs: L, lines: { pts: 21.5 }, market: { pts: [{ b: "DK", l: 21.5, o: -110, u: -110 }] } };
  const good = M.bestBet(p, "pts", "nba").confidence;
  assert.equal(good.grade, "High"); assert.equal(good.score, 100);
  const bad = M.confidence({ ...p, injury: "Questionable" }, "pts", "nba", M.project(p, "pts", "nba"),
    { line: 30.5, price: 400, model: 0.45, market: 0.18, vol: 5 });
  assert.equal(bad.grade, "Low");
  assert.ok(bad.why.some(w => /disagree/.test(w.txt)) && bad.why.some(w => /questionable/.test(w.txt)));
});

test("game model: stronger home side is favored, probabilities consistent, bets priced", () => {
  const form = (pf, pa) => Array.from({ length: 10 }, (_, i) => ({ date: `2026-10-${String(30 - i).padStart(2, "0")}`, pf, pa }));
  const g = { home: "NY", away: "MIL", form: { NY: form(120, 105), MIL: form(108, 116) },
    dk: { book: "DraftKings", ml: { home: -400, away: 320 }, spread: { home: -9.5, homeOdds: -110, awayOdds: -110 }, total: { line: 224.5, over: -110, under: -110 } },
    kalshi: { ml: { NY: { o: -300, u: 240 } }, spread: [{ team: "NY", l: 9.5, o: -105, u: -115 }], total: [{ l: 224.5, o: -110, u: -110 }] } };
  const m = M.gameModel(g, "nba");
  assert.ok(m.margin > 5 && m.pWin("NY") > 0.6);
  assert.ok(Math.abs(m.pWin("NY") + m.pWin("MIL") - 1) < 1e-9);
  assert.ok(Math.abs(m.pBy("NY", 9.5) + m.pBy("MIL", -9.5) - 1) < 1e-9);
  assert.ok(m.pOver(200) > m.pOver(240));
  const { bets } = M.gameBets(g, "nba");
  assert.ok(bets.length >= 8 && bets.every(b => b.prob > 0 && b.prob < 1));
  assert.ok(bets[0].ev >= bets[bets.length - 1].ev);
  // the blend leans on the market: a 50/50 market total stays near 50%
  const ov = bets.find(b => b.label === "Over 224.5" && b.book === "DraftKings");
  assert.ok(Math.abs(ov.prob - 0.5) < 0.08);
  // hockey uses Poisson for goals
  const h = M.gameModel({ home: "TOR", away: "COL", form: { TOR: form(3, 3), COL: form(3.4, 2.8) } }, "nhl");
  assert.ok(h.total > 5 && h.total < 7.5 && h.pOver(6.5) > 0.2 && h.pOver(6.5) < 0.7);
});

test("game model uses this season's games; last season only when this one has barely started", () => {
  const cur = Array.from({ length: 6 }, (_, i) => ({ date: `2026-11-${String(9 - i).padStart(2, "0")}`, pf: 120, pa: 100, season: "cur" }));
  const prev = Array.from({ length: 10 }, (_, i) => ({ date: `2026-04-${String(10 - i).padStart(2, "0")}`, pf: 90, pa: 120, season: "prev" }));
  assert.equal(M.seasonForm([...cur, ...prev]).length, 6);
  assert.equal(M.seasonForm([...cur.slice(0, 3), ...prev]).length, 13);                  // fewer than 5: keep last season too
  const unflagged = [...cur, ...prev].map(({ season, ...x }) => x);                        // older data: split at the off-season gap
  assert.equal(M.seasonForm(unflagged).length, 6);
});
