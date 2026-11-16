#!/usr/bin/env node
/**
 * In-game Kalshi NBA props: is there EV during the game? Uses 1-minute quotes from tip to final
 * (scripts/minute-study.mjs collect --ingame → .cache/nba-live-*.json) and Kalshi's result.
 *
 * At fixed minutes after tip (15, 30, 45, 60, 90, 120) a market counts only if it was quoted two-sided in the two
 * minutes up to that moment — information available then (an over that already hit has closed and has no quote,
 * so it can't sneak in). Reports calibration by time and price, then simple rules and a fitted layer
 * (price + time since tip), scored leave-one-day-out and strictly forward, after taker fees.
 *
 *   node scripts/live-study.mjs
 * Optimistic: assumes you trade at the minute's quote with no delay and that size is there.
 */
import { readFileSync, readdirSync } from "node:fs";
const { logistic } = await import("./market-fit.mjs");
const read = f => JSON.parse(readFileSync(f, "utf8"));
const fee = p => Math.ceil(0.07 * p * (1 - p) * 100 - 1e-9) / 100;
const lg = p => Math.log(Math.min(.99, Math.max(.01, p)) / (1 - Math.min(.99, Math.max(.01, p)))), sig = x => 1 / (1 + Math.exp(-x));
const LL = (p, y) => -(y ? Math.log(Math.max(p, 1e-4)) : Math.log(Math.max(1 - p, 1e-4)));
const hist = read(".cache/kalshi-history.json").events;
const live = {}; for (const f of readdirSync(".cache").filter(f => /^nba-live-\d+\.json$/.test(f))) Object.assign(live, read(`.cache/${f}`));
const AT = [15, 30, 45, 60, 90, 120];
const rows = [];
for (const [tk, cs] of Object.entries(live)) {
  const e = hist[tk]; if (!e?.tip || cs.err) continue;
  for (const m of e.markets) {
    const k = cs[m.tk]; if (!k?.length) continue; k.sort((a, b) => a[0] - b[0]);
    for (const at of AT) {
      const t = e.tip + at * 60, w = k.filter(x => x[0] > t - 120 && x[0] <= t);   // a quote in the last two minutes, nothing later
      const lastQ = w.reverse().find(x => x[1] != null && x[2] != null); if (!lastQ) continue;
      const [, bid, ask] = lastQ; if (!(bid > 0.02 && ask < 0.98 && ask - bid <= 0.10 && ask > bid)) continue;
      rows.push({ at, date: e.date, stat: e.stat, y: m.y, bid, ask, mid: (bid + ask) / 2, key: `${tk}|${m.tk}` });
    }
  }
}
const days = [...new Set(rows.map(r => r.date))].sort();
console.log(`${Object.keys(live).length} events · ${rows.length} in-game market snapshots (${AT.join("/")} min after tip), ${days.length} days ${days[0]} … ${days.at(-1)}`);
const roi = b => { if (!b.length) return "    —"; const c = b.reduce((a, x) => a + x.cost, 0); return `${String(b.length).padStart(5)} bets ${(((b.reduce((a, x) => a + x.hit, 0) - c) / c) * 100).toFixed(1).padStart(6)}%`; };
const half = days[Math.floor(days.length / 2)];

console.log("\ncalibration: YES won vs price (mid), by minutes after tip");
for (const at of AT) { const R = rows.filter(r => r.at === at);
  console.log(`  ${String(at).padStart(3)} min  n=${String(R.length).padStart(5)}  ` + [[0.03, 0.15], [0.15, 0.35], [0.35, 0.65], [0.65, 0.85], [0.85, 0.97]].map(([a, b]) => { const g = R.filter(r => r.mid >= a && r.mid < b); return g.length >= 40 ? `${a * 100}-${b * 100}¢ ${(g.reduce((x, r) => x + r.y, 0) / g.length * 100).toFixed(0)}% vs ${(g.reduce((x, r) => x + r.mid, 0) / g.length * 100).toFixed(0)}%` : `${a * 100}-${b * 100}¢ —`; }).join(" | ")); }

console.log("\nsimple rules after fees, one bet per market per snapshot time (1st half | 2nd half of the days):");
const rule = (name, f, side) => { const b = rows.filter(f).map(r => { const c = side === "yes" ? r.ask : 1 - r.bid; return { cost: c + fee(c), hit: side === "yes" ? r.y : 1 - r.y, date: r.date }; });
  console.log(`  ${name.padEnd(46)} ${roi(b)} | ${roi(b.filter(x => x.date < half))} | ${roi(b.filter(x => x.date >= half))}`); };
for (const [lo, hi] of [[0.85, 0.97], [0.65, 0.85], [0.35, 0.65], [0.15, 0.35], [0.03, 0.15]]) { rule(`YES when ${lo * 100}–${hi * 100}¢`, r => r.mid >= lo && r.mid < hi, "yes"); rule(`NO  when ${lo * 100}–${hi * 100}¢`, r => r.mid >= lo && r.mid < hi, "no"); }
rule("YES 85–97¢, 90+ min in (late, near-certain)", r => r.at >= 90 && r.mid >= 0.85, "yes");
rule("NO on YES 3–15¢, 90+ min in (late long shots)", r => r.at >= 90 && r.mid < 0.15, "no");

console.log("\nfitted layer (price + minutes since tip), board rule EV after fees:");
const X = r => [1, lg(r.mid), r.at / 60, lg(r.mid) * r.at / 60];
const qL = [], qF = [];
for (const d of days) {
  const tr = rows.filter(r => r.date !== d), b = logistic(tr.map(X), tr.map(r => r.y), 5);
  const past = rows.filter(r => r.date < d), bf = new Set(past.map(r => r.date)).size >= 4 ? logistic(past.map(X), past.map(r => r.y), 5) : null;
  rows.forEach((r, i) => { if (r.date !== d) return; qL[i] = sig(X(r).reduce((a, v, j) => a + v * b[j], 0)); qF[i] = bf ? sig(X(r).reduce((a, v, j) => a + v * bf[j], 0)) : null; });
}
const fw = rows.map((_, i) => i).filter(i => qF[i] != null);
console.log(`  log loss: mid ${(rows.reduce((a, r) => a + LL(r.mid, r.y), 0) / rows.length).toFixed(4)} → fit (leave-one-day-out) ${(rows.reduce((a, r, i) => a + LL(qL[i], r.y), 0) / rows.length).toFixed(4)} | forward: mid ${(fw.reduce((a, i) => a + LL(rows[i].mid, rows[i].y), 0) / fw.length).toFixed(4)} → fit ${(fw.reduce((a, i) => a + LL(qF[i], rows[i].y), 0) / fw.length).toFixed(4)}`);
for (const [mode, q] of [["leave-one-day-out", qL], ["strictly forward", qF]]) for (const t of [0.02, 0.05, 0.10]) {
  const best = new Map(); rows.forEach((r, i) => { if (q[i] == null) return; for (const side of ["yes", "no"]) { const c = side === "yes" ? r.ask : 1 - r.bid; if (c < 0.05 || c > 0.95) continue;
    const cost = c + fee(c), e = (side === "yes" ? q[i] : 1 - q[i]) / cost - 1; if (e < t) continue; const k = r.key + r.at, o = best.get(k); if (!o || e > o.e) best.set(k, { e, cost, hit: side === "yes" ? r.y : 1 - r.y, date: r.date }); } });
  const b = [...best.values()]; console.log(`  ${mode.padEnd(18)} EV ≥ ${String(t * 100).padStart(2)}%: ${roi(b)} | 1st half ${roi(b.filter(x => x.date < half))} | 2nd half ${roi(b.filter(x => x.date >= half))}`); }
