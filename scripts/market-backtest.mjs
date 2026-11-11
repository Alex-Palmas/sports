#!/usr/bin/env node
/**
 * Scores the edge model against the real Kalshi market.
 *
 * Input: settled NBA prop markets with their pre-game YES bid/ask (scripts/kalshi-history.mjs) and
 * the player game logs in site/data.json. For every market the player is rebuilt as he looked
 * before that game (older games only, point-in-time defense vs position), the model prices the
 * strike, and both the model and the market are scored against the result.
 *
 *   node scripts/market-backtest.mjs [.cache/kalshi-history.json] [site/data.json]
 *
 * Reports: log loss of market vs model vs blends (→ the best marketWeight), calibration of the
 * market by price, and what the Edge Board's pick rule would have earned after Kalshi fees.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dvpIndex, posGroup } from "./backtest-model.mjs";
const M = createRequire(import.meta.url)("../site/model.js");

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const days = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400e3);
const addDay = (d, n) => new Date(Date.parse(d) + n * 86400e3).toISOString().slice(0, 10);
const norm = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, "").replace(/[^a-z]/g, "");
const fee = p => Math.ceil(0.07 * p * (1 - p) * 100 - 1e-9) / 100;   // one contract, taker
const LL = (p, y) => -(y ? Math.log(clamp(p, 1e-4, 1 - 1e-4)) : Math.log(clamp(1 - p, 1e-4, 1 - 1e-4)));
const DERIVED = { pr: ["pts", "reb"], pa: ["pts", "ast"], ra: ["reb", "ast"], pra: ["pts", "reb", "ast"] };
const statOf = (l, s) => l.stats?.[s] ?? (DERIVED[s] ? DERIVED[s].reduce((a, k) => a + (l.stats?.[k] ?? 0), 0) : 0);

/** One row per settled market with a usable pre-game quote: the player as of that morning, the strike and the result. */
export function buildRows(hist, sport) {
  const byName = new Map(sport.players.map(p => [norm(p.name), p]));
  const stats = [...new Set([...sport.stats.map(s => s.key), "pr", "pa", "ra"])];
  const players = sport.players.map(p => ({ ...p, logs: p.logs.map(l => ({ ...l, stats: { ...l.stats, ...Object.fromEntries(Object.keys(DERIVED).map(k => [k, statOf(l, k)])) } })) }));
  const pmap = new Map(players.map(p => [norm(p.name), p]));
  const dvp = dvpIndex("nba", players, stats);
  const rows = [];
  for (const [ev, e] of Object.entries(hist.events)) for (const m of e.markets) {
    if (m.bid == null || m.ask == null || !(m.ask > m.bid - 1e-9)) continue;
    const p = pmap.get(norm(m.name)); if (!p || !byName.has(norm(m.name))) continue;
    // ESPN log dates are UTC: an evening ET game on D is logged D or D+1. The settlement value confirms it.
    const j = p.logs.findIndex(l => (l.date === e.date || l.date === addDay(e.date, 1)) && (m.value == null || statOf(l, e.stat) === m.value));
    if (j < 0) continue;
    const g = p.logs[j], prior = p.logs.slice(j + 1);
    if (prior.length < 5) continue;
    const d = dvp(posGroup("nba", p.pos), g.opp, e.stat, g.date, g.season);
    const pp = { pos: p.pos, logs: prior, home: g.home, opp: g.opp, restDays: Math.max(0, days(g.date, prior[0].date) - 1), withWithout: [], game: {},
      dvp: d ? { group: posGroup("nba", p.pos), factor: { [e.stat]: d.f }, n: { [e.stat]: d.n }, rank: {}, of: 0 } : null };
    rows.push({ ev, game: `${ev.split("-")[1]}|${norm(m.name)}`, stat: e.stat, name: m.name, date: e.date, line: m.strike, y: m.y, bid: m.bid, ask: m.ask, mid: (m.bid + m.ask) / 2, mid0: m.mid0 ?? null, vol: m.vol || 0, p: pp, actual: m.value, min: g.min });
  }
  return rows;
}

/** Model P(over) for each row (settings `over` like the main backtest). */
export function modelProbs(rows, over) {
  const cache = new Map();
  return rows.map(r => {
    const k = r.game + r.stat; let proj = cache.get(k);
    if (proj === undefined) { proj = M.project(r.p, r.stat, "nba", over); cache.set(k, proj); }
    return proj ? M.probabilities(r.p, r.stat, r.line, proj, "nba", over).over : null;
  });
}

/**
 * The Edge Board's rule on history: per player/stat/game, the side and strike with the best EV at the
 * price you'd actually pay (YES at the ask, NO at 1 − bid), blended with weight w on the market mid.
 * Bets one contract per pick; returns count, hit rate, ROI after fees, and the average predicted win chance.
 */
export function simulate(rows, probs, w, minEv = 0, maxPrice = 0.75, minPrice = 0.25) {
  const best = new Map();
  rows.forEach((r, i) => {
    if (probs[i] == null) return;
    const q = (1 - w) * probs[i] + w * r.mid;
    for (const side of ["yes", "no"]) {
      const cost = side === "yes" ? r.ask : 1 - r.bid, win = side === "yes" ? q : 1 - q;
      if (!(cost >= minPrice && cost <= maxPrice)) continue;
      const evv = win - cost - fee(cost);
      if (evv < minEv) continue;
      const k = r.game + r.stat, b = best.get(k);
      if (!b || evv > b.ev) best.set(k, { ev: evv, cost, win, hit: side === "yes" ? r.y : 1 - r.y, f: fee(cost) });
    }
  });
  const b = [...best.values()], staked = b.reduce((a, x) => a + x.cost + x.f, 0), back = b.reduce((a, x) => a + x.hit, 0);
  return { bets: b.length, hit: b.length ? back / b.length : null, expectedHit: b.length ? b.reduce((a, x) => a + x.win, 0) / b.length : null, roi: staked ? (back - staked) / staked : null, avgEv: b.length ? b.reduce((a, x) => a + x.ev, 0) / b.length : null };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const HIST = process.argv.find(a => /kalshi-history.*\.json$/.test(a)) || ".cache/kalshi-history.json";
  const DATA = process.argv.find(a => /data\.json$/.test(a)) || "site/data.json";
  const hist = JSON.parse(readFileSync(HIST, "utf8")), data = JSON.parse(readFileSync(DATA, "utf8"));
  const rows = buildRows(hist, data.sports.nba).filter(r => r.ask - r.bid <= 0.1 && r.mid > 0.03 && r.mid < 0.97);
  const probs = modelProbs(rows, M.cfg("nba")), ok = rows.map((_, i) => probs[i] != null);
  const R = rows.filter((_, i) => ok[i]), P = probs.filter((_, i) => ok[i]);
  console.log(`markets: ${R.length} (${new Set(R.map(r => r.game)).size} player-games, ${R[0]?.date}…${R.at(-1)?.date})`);
  const ll = f => R.reduce((a, r, i) => a + LL(f(r, i), r.y), 0) / R.length;
  console.log("log loss  market mid", ll(r => r.mid).toFixed(4), "| model", ll((r, i) => P[i]).toFixed(4), "| always 50%", (Math.log(2)).toFixed(4));
  for (const w of [0, 0.5, 0.65, 0.8, 0.9, 0.95, 1]) console.log(`  blend w=${w}`.padEnd(14), ll((r, i) => (1 - w) * P[i] + w * r.mid).toFixed(4));
  console.log("by stat (market | model):"); for (const s of [...new Set(R.map(r => r.stat))]) { const ix = R.map((r, i) => r.stat === s ? i : -1).filter(i => i >= 0); const l = f => ix.reduce((a, i) => a + LL(f(i), R[i].y), 0) / ix.length; console.log(`  ${s.padEnd(4)} n=${String(ix.length).padEnd(5)} ${l(i => R[i].mid).toFixed(4)} | ${l(i => P[i]).toFixed(4)}`); }
  console.log("market calibration (mid → actual):"); for (let b = 0; b < 10; b++) { const g = R.filter(r => Math.floor(r.mid * 10) === b); if (g.length) console.log(`  ${b * 10}-${b * 10 + 10}%  n=${String(g.length).padEnd(5)} actual ${(g.reduce((a, r) => a + r.y, 0) / g.length * 100).toFixed(1)}%  avg mid ${(g.reduce((a, r) => a + r.mid, 0) / g.length * 100).toFixed(1)}%`); }
  console.log("Edge Board rule (1 contract per pick, after fees):");
  for (const w of [0.65, 0.8, 0.9]) for (const minEv of [0, 0.02, 0.05]) { const s = simulate(R, P, w, minEv); console.log(`  w=${w} minEV=${minEv}: ${s.bets} bets, hit ${(s.hit * 100).toFixed(1)}% (expected ${(s.expectedHit * 100).toFixed(1)}%), ROI ${(s.roi * 100).toFixed(1)}%`); }
}
