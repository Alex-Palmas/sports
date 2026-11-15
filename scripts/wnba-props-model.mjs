#!/usr/bin/env node
/**
 * Do WNBA player stats beat Kalshi's WNBA prop prices? Settled Kalshi WNBA props with the pre-tip quote
 * (scripts/kalshi-history.mjs --league wnba) joined by name and date to ESPN game logs (scripts/wnba-players.mjs),
 * earlier games only — never on the outcome. Fitted layers on Kalshi's price, leave-one-week-out and strictly
 * forward, then the Edge Board rule after fees in both halves.
 *   node scripts/wnba-props-model.mjs
 */
import { readFileSync } from "node:fs";
const { logistic } = await import("./market-fit.mjs");
const read = f => JSON.parse(readFileSync(f, "utf8"));
const norm = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, "").replace(/[^a-z]/g, "");
const fee = p => Math.ceil(0.07 * p * (1 - p) * 100 - 1e-9) / 100, clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lg = p => { p = clamp(p, 0.01, 0.99); return Math.log(p / (1 - p)); }, sig = x => 1 / (1 + Math.exp(-x));
const LL = (p, y) => -(y ? Math.log(clamp(p, 1e-4, 1)) : Math.log(clamp(1 - p, 1e-4, 1)));
const week = d => Math.floor((Date.parse(d) - Date.parse("2026-05-05")) / 6048e5);
const n = v => { const x = parseFloat(String(v ?? "").split("-")[0]); return Number.isFinite(x) ? x : 0; };
const BASE = { pts: r => n(r.points), reb: r => n(r.totalRebounds), ast: r => n(r.assists), fg3: r => n(r.threePointFieldGoalsMade_threePointFieldGoalsAttempted ?? r["threePointFieldGoalsMade-threePointFieldGoalsAttempted"]) };
const STAT = { ...BASE, pr: r => BASE.pts(r) + BASE.reb(r), pa: r => BASE.pts(r) + BASE.ast(r), ra: r => BASE.reb(r) + BASE.ast(r), pra: r => BASE.pts(r) + BASE.reb(r) + BASE.ast(r) };

const hist = read(".cache/kalshi-history-wnba.json").events, P = new Map(read(".cache/wnba-players.json").players.map(p => [norm(p.name), p]));
const rows = []; let noPlayer = 0;
for (const [k, e] of Object.entries(hist)) {
  const f = STAT[e.stat]; if (!f) continue;
  for (const m of e.markets) {
    if (m.bid == null || m.ask == null || m.ask - m.bid > 0.10) continue;
    const mid = (m.bid + m.ask) / 2; if (mid <= 0.03 || mid >= 0.97) continue;
    const p = P.get(norm(m.name)); if (!p) { noPlayer++; continue; }
    const prior = p.logs.filter(l => l.date < e.date && n(l.raw.minutes) > 0); if (prior.length < 5) continue;
    const xs = prior.slice(0, 10).map(l => f(l.raw)), l3 = xs.slice(0, 3), mins = prior.slice(0, 5).map(l => n(l.raw.minutes));
    const mu = xs.reduce((a, x) => a + x, 0) / xs.length, sd = Math.sqrt(xs.reduce((a, x) => a + (x - mu) ** 2, 0) / (xs.length - 1)) || 1;
    rows.push({ s: e.stat, w: week(e.date), y: m.y, bid: m.bid, ask: m.ask, mid, key: `${k}|${norm(m.name)}`, vol: m.vol ?? 0,
      pEmp: (xs.filter(x => x > m.strike).length + 0.5) / (xs.length + 1), pNorm: sig(1.7 * (mu - m.strike) / Math.max(sd, 1)), pRecent: (l3.filter(x => x > m.strike).length + 0.5) / 4,
      minTrend: (mins[0] + mins[1]) / 2 - mins.reduce((a, x) => a + x, 0) / mins.length });
  }
}
const weeks = [...new Set(rows.map(r => r.w))].sort((a, b) => a - b), half = weeks[Math.floor(weeks.length / 2)];
console.log(`${rows.length} WNBA prop markets with a pre-tip quote and ≥5 earlier games (${new Set(rows.map(r => r.key)).size} player-games, ${weeks.length} weeks; ${noPlayer} without an ESPN match)`);
console.log("by stat:", Object.entries(rows.reduce((a, r) => (a[r.s] = (a[r.s] || 0) + 1, a), {})).map(([k, v]) => `${k} ${v}`).join(", "));
console.log("calibration (YES priced → hit):", [[0.1, 0.3], [0.3, 0.5], [0.5, 0.7], [0.7, 0.9]].map(([a, b]) => { const g = rows.filter(r => r.mid >= a && r.mid < b); return `${a * 100}-${b * 100}¢ ${(g.reduce((x, r) => x + r.y, 0) / g.length * 100).toFixed(1)}% vs ${(g.reduce((x, r) => x + r.mid, 0) / g.length * 100).toFixed(1)}% (n=${g.length})`; }).join(" | "));
const STATS = [...new Set(rows.map(r => r.s))];
const MODELS = {
  "price only": r => [1, lg(r.mid)],
  "price + stat type": r => [1, lg(r.mid), ...STATS.slice(1).map(s => r.s === s ? 1 : 0)],
  "price + hit rate (last 10)": r => [1, lg(r.mid), lg(r.pEmp) - lg(r.mid)],
  "price + average vs line": r => [1, lg(r.mid), lg(r.pNorm) - lg(r.mid)],
  "price + recent 3 games": r => [1, lg(r.mid), lg(r.pRecent) - lg(r.mid)],
  "price + minutes trend": r => [1, lg(r.mid), r.minTrend / 5],
  "price + all": r => [1, lg(r.mid), ...STATS.slice(1).map(s => r.s === s ? 1 : 0), lg(r.pEmp) - lg(r.mid), lg(r.pNorm) - lg(r.mid), lg(r.pRecent) - lg(r.mid), r.minTrend / 5],
};
const out = {};
for (const [name, X] of Object.entries(MODELS)) {
  const qL = [], qF = [];
  for (const w of weeks) {
    const tr = rows.filter(r => r.w !== w), b = logistic(tr.map(X), tr.map(r => r.y), 5);
    const past = rows.filter(r => r.w < w), bf = new Set(past.map(r => r.w)).size >= 4 ? logistic(past.map(X), past.map(r => r.y), 5) : null;
    rows.forEach((r, i) => { if (r.w !== w) return; qL[i] = sig(X(r).reduce((a, v, j) => a + v * b[j], 0)); qF[i] = bf ? sig(X(r).reduce((a, v, j) => a + v * bf[j], 0)) : null; });
  }
  const fw = rows.map((_, i) => i).filter(i => qF[i] != null);
  out[name] = { qL, qF, ll: rows.reduce((a, r, i) => a + LL(qL[i], r.y), 0) / rows.length, llF: fw.reduce((a, i) => a + LL(qF[i], rows[i].y), 0) / fw.length, llMidF: fw.reduce((a, i) => a + LL(rows[i].mid, rows[i].y), 0) / fw.length, coef: logistic(rows.map(X), rows.map(r => r.y), 5) };
}
console.log(`\nlog loss (lower is better). Kalshi mid: ${(rows.reduce((a, r) => a + LL(r.mid, r.y), 0) / rows.length).toFixed(5)} (forward weeks: ${out["price only"].llMidF.toFixed(5)})`);
for (const [k, o] of Object.entries(out)) console.log(`  ${k.padEnd(28)} leave-one-week-out ${o.ll.toFixed(5)} | forward ${o.llF.toFixed(5)} | coef ${o.coef.map(c => c.toFixed(3)).join(", ")}`);
const board = (q, t) => { const best = new Map(); rows.forEach((r, i) => { if (q[i] == null) return; for (const side of ["yes", "no"]) { const c = side === "yes" ? r.ask : 1 - r.bid; if (c < 0.2 || c > 0.8) continue;
  const cost = c + fee(c), e = (side === "yes" ? q[i] : 1 - q[i]) / cost - 1; if (e < t) continue; const k = r.key + r.s, o = best.get(k); if (!o || e > o.e) best.set(k, { e, cost, hit: side === "yes" ? r.y : 1 - r.y, w: r.w, side }); } }); return [...best.values()]; };
const roi = b => { if (!b.length) return "    —"; const c = b.reduce((a, x) => a + x.cost, 0); return `${String(b.length).padStart(5)} bets ${(((b.reduce((a, x) => a + x.hit, 0) - c) / c) * 100).toFixed(1).padStart(6)}%`; };
for (const [k, o] of Object.entries(out)) { if (k === "price only") continue;
  console.log(`\n${k}: board rule after fees (1st half = weeks < ${half})`);
  for (const [mode, q] of [["leave-one-week-out", o.qL], ["strictly forward", o.qF]]) for (const t of [0.03, 0.05, 0.10, 0.25]) { const b = board(q, t);
    console.log(`  ${mode.padEnd(19)} EV ≥ ${String(t * 100).padStart(2)}%: ${roi(b)} | 1st half ${roi(b.filter(x => x.w < half))} | 2nd half ${roi(b.filter(x => x.w >= half))} | NO ${b.length ? Math.round(b.filter(x => x.side === "no").length / b.length * 100) : 0}%`); } }
