#!/usr/bin/env node
/**
 * The Edge Board rule replayed straight from Kalshi's own results: no ESPN join, so nothing about the outcome
 * can leak in. Every settled NBA prop with a pre-tip quote; the Conservative layer (logit P = b0 + bMid·logit(mid)
 * + stat-type terms) is refit each day on earlier days only, then the board's pick (best side/strike per
 * player-stat-game, cost 20–80¢, EV after fee) is bet at that day's prices.
 *
 *   node scripts/ev-direct.mjs [--min 0.02]
 */
import { readFileSync } from "node:fs";
const { logistic } = await import("./market-fit.mjs");
const MIN = +(process.argv[process.argv.indexOf("--min") + 1] || 0.02);
const hist = JSON.parse(readFileSync(".cache/kalshi-history.json", "utf8")).events;
const lg = p => Math.log(Math.min(.99, Math.max(.01, p)) / (1 - Math.min(.99, Math.max(.01, p)))), sig = x => 1 / (1 + Math.exp(-x));
const fee = p => Math.ceil(0.07 * p * (1 - p) * 100 - 1e-9) / 100, norm = s => String(s || "").toLowerCase().replace(/[^a-z]/g, "");
const rows = [];
for (const [ev, e] of Object.entries(hist)) for (const m of e.markets) {
  if (m.bid == null || m.ask == null || m.ask - m.bid > 0.12) continue;
  const mid = (m.bid + m.ask) / 2; if (mid <= 0.03 || mid >= 0.97) continue;
  rows.push({ date: e.date, stat: e.stat, game: `${ev.split("-")[1]}|${norm(m.name)}`, y: m.y, bid: m.bid, ask: m.ask, mid });
}
const X = r => [1, lg(r.mid), /^(pra|pr|pa|ra)$/.test(r.stat) ? 1 : 0, r.stat === "pts" ? 1 : 0];
const days = [...new Set(rows.map(r => r.date))].sort();
console.log(`${rows.length} settled NBA prop markets with a pre-tip quote, ${days.length} days (${days[0]} … ${days.at(-1)}); EV ≥ ${MIN * 100}%`);
const all = [], byDay = [];
for (const d of days) {
  const past = rows.filter(r => r.date < d); if (new Set(past.map(r => r.date)).size < 5) continue;
  const b = logistic(past.map(X), past.map(r => r.y), 5), best = new Map();
  for (const r of rows.filter(r => r.date === d)) { const q = sig(X(r).reduce((a, v, j) => a + v * b[j], 0));
    for (const side of ["yes", "no"]) { const c = side === "yes" ? r.ask : 1 - r.bid; if (c < 0.2 || c > 0.8) continue;
      const cost = c + fee(c), e = (side === "yes" ? q : 1 - q) / cost - 1; if (e < MIN) continue;
      const k = r.game + r.stat, o = best.get(k); if (!o || e > o.e) best.set(k, { e, cost, hit: side === "yes" ? r.y : 1 - r.y, side, d }); } }
  const P = [...best.values()]; all.push(...P);
  const c = P.reduce((a, x) => a + x.cost, 0), w = P.reduce((a, x) => a + x.hit, 0);
  byDay.push({ d, n: P.length, roi: c ? (w - c) / c : null, pnl: w - c });
}
const c = all.reduce((a, x) => a + x.cost, 0), w = all.reduce((a, x) => a + x.hit, 0);
console.log(`picks ${all.length} · won ${(w / all.length * 100).toFixed(1)}% · expected ${(all.reduce((a, x) => a + (x.e + 1) * x.cost, 0) / all.length * 100).toFixed(1)}% · avg cost ${(c / all.length * 100).toFixed(1)}¢ · ROI ${((w - c) / c * 100).toFixed(1)}% · NO ${Math.round(all.filter(x => x.side === "no").length / all.length * 100)}%`);
let seed = 5; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647, bs = [];
for (let i = 0; i < 4000; i++) { let cc = 0, ww = 0; for (let j = 0; j < byDay.length; j++) { const dd = byDay[Math.floor(rnd() * byDay.length)].d; for (const x of all) if (x.d === dd) { cc += x.cost; ww += x.hit; } } bs.push(cc ? (ww - cc) / cc : 0); }
bs.sort((a, b) => a - b); console.log(`90% range (resampling whole days): ${(bs[200] * 100).toFixed(1)}% … ${(bs[3800] * 100).toFixed(1)}%`);
for (const [lo, hi] of [[0.02, 0.05], [0.05, 0.10], [0.10, 1]]) { const g = all.filter(x => x.e >= lo && x.e < hi); if (!g.length) continue; const cc = g.reduce((a, x) => a + x.cost, 0), ww = g.reduce((a, x) => a + x.hit, 0); console.log(`  EV ${lo * 100}–${hi < 1 ? hi * 100 + "%" : "up"}: ${g.length} picks, ROI ${((ww - cc) / cc * 100).toFixed(1)}%`); }
console.log("by day: " + byDay.map(x => `${x.d.slice(5)} ${x.n}→${x.roi == null ? "—" : (x.roi * 100).toFixed(0) + "%"}`).join("  "));
