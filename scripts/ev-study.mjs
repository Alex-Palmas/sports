/**
 * EV-bracket study of the Edge Board pick rule on settled Kalshi NBA props (see docs/model-changelog.md).
 * One pick per player/stat/game (best EV per $ after fee, cost 20–80¢), scored leave-one-day-out and
 * strictly forward (each day fit only on earlier days), with day-clustered bootstrap ranges.
 *
 *   node scripts/ev-study.mjs [site/data.json] [out.txt]
 */
import { readFileSync, writeFileSync } from "node:fs";
const R = new URL("./", import.meta.url).href;
const { buildRows } = await import(R + "market-backtest.mjs"); const { logistic } = await import(R + "market-fit.mjs");
const hist = JSON.parse(readFileSync(".cache/kalshi-history.json", "utf8"));
const data = JSON.parse(readFileSync(process.argv[2] || "site/data.json", "utf8"));
const rows = buildRows(hist, data.sports.nba).filter(r => r.ask - r.bid <= 0.12 && r.mid > 0.03 && r.mid < 0.97);
const lg = p => Math.log(Math.min(.99, Math.max(.01, p)) / (1 - Math.min(.99, Math.max(.01, p)))), sig = x => 1 / (1 + Math.exp(-x));
const fee = p => Math.ceil(0.07 * p * (1 - p) * 100 - 1e-9) / 100;
const X = r => [1, lg(r.mid), /^(pra|pr|pa|ra)$/.test(r.stat) ? 1 : 0, r.stat === "pts" ? 1 : 0];
const days = [...new Set(rows.map(r => r.date))].sort();
console.log(`${rows.length} markets, ${days.length} days (${days[0]} … ${days.at(-1)}), ${new Set(rows.map(r => r.game)).size} player-games`);

// two ways to score each day: leave-one-day-out, and strictly forward (fit only on earlier days, needs 5+ days)
const qLodo = [], qFwd = [];
for (const d of days) {
  const tr = rows.filter(r => r.date !== d), b = logistic(tr.map(X), tr.map(r => r.y), 5);
  const past = rows.filter(r => r.date < d), bf = new Set(past.map(r => r.date)).size >= 5 ? logistic(past.map(X), past.map(r => r.y), 5) : null;
  rows.forEach((r, i) => { if (r.date !== d) return; qLodo[i] = sig(X(r).reduce((a, v, j) => a + v * b[j], 0)); qFwd[i] = bf ? sig(X(r).reduce((a, v, j) => a + v * bf[j], 0)) : null; });
}
/** The board's rule: one pick per player/stat/game = best EV per $ after fee, cost 0.20–0.80. */
function picks(q) {
  const best = new Map();
  rows.forEach((r, i) => { if (q[i] == null) return; for (const side of ["yes", "no"]) {
    const c = side === "yes" ? r.ask : 1 - r.bid; if (c < 0.2 || c > 0.8) continue;
    const cost = c + fee(c), win = side === "yes" ? q[i] : 1 - q[i], e = win / cost - 1;
    const k = r.game + r.stat, o = best.get(k); if (!o || e > o.e) best.set(k, { e, cost, win, hit: side === "yes" ? r.y : 1 - r.y, side, r });
  } });
  return [...best.values()];
}
const P = { lodo: picks(qLodo), fwd: picks(qFwd) };
// stats with day-clustered bootstrap (resample whole days) for a 90% interval on ROI
function stat(g, B = 1000) {
  if (!g.length) return null;
  const st = g.reduce((a, x) => a + x.cost, 0), ret = g.reduce((a, x) => a + x.hit, 0), roi = (ret - st) / st;
  const byDay = {}; for (const x of g) (byDay[x.r.date] ||= []).push(x);
  const dk = Object.keys(byDay), dayRoi = dk.map(d => { const s = byDay[d].reduce((a, x) => a + x.cost, 0), r = byDay[d].reduce((a, x) => a + x.hit, 0); return r - s; });
  const sims = [];
  for (let b = 0; b < B; b++) { let s = 0, r = 0; for (let k = 0; k < dk.length; k++) { const d = byDay[dk[Math.floor(Math.random() * dk.length)]]; for (const x of d) { s += x.cost; r += x.hit; } } sims.push((r - s) / s); }
  sims.sort((a, b) => a - b);
  return { n: g.length, won: ret / g.length, exp: g.reduce((a, x) => a + x.win, 0) / g.length, roi, lo: sims[Math.floor(B * 0.05)], hi: sims[Math.floor(B * 0.95)], days: dk.length, upDays: dayRoi.filter(v => v > 0).length };
}
const pct = x => x == null ? "—" : (x * 100 >= 0 ? "+" : "") + (x * 100).toFixed(1) + "%";
const line = (name, s) => s ? `${name.padEnd(30)} ${String(s.n).padStart(5)}  won ${(s.won * 100).toFixed(1).padStart(5)}% (model ${(s.exp * 100).toFixed(0)}%)  ROI ${pct(s.roi).padStart(7)}  90% range ${pct(s.lo)} … ${pct(s.hi)}  days up ${s.upDays}/${s.days}` : `${name.padEnd(30)} —`;
const out = [];
const log = s => { console.log(s); out.push(s); };
const BR = [[0.02, 0.05], [0.05, 0.10], [0.10, 0.15], [0.15, 0.20], [0.20, 0.25], [0.25, 0.30], [0.30, 0.40], [0.40, 0.60], [0.60, 9]];
for (const [mode, ps] of Object.entries(P)) {
  const g = ps.filter(x => x.e >= 0.02), half = days[Math.floor(days.length / 2)], last7 = days.slice(-7)[0];
  log(`\n=== ${mode === "lodo" ? "Leave-one-day-out" : "Strictly forward (each day fit on earlier days only)"}: ${g.length} picks with EV ≥ 2%`);
  log("EV bracket                       bets   won           ROI      90% range (day bootstrap)   days up");
  for (const [a, b] of BR) log(line(`  ${Math.round(a * 100)}–${b > 5 ? "∞" : Math.round(b * 100)}%`, stat(g.filter(x => x.e >= a && x.e < b))));
  log("Minimum-EV cutoff (everything at or above):");
  for (const a of [0.02, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.50]) {
    const s = g.filter(x => x.e >= a), h1 = stat(s.filter(x => x.r.date < half), 200), h2 = stat(s.filter(x => x.r.date >= half), 200), l7 = stat(s.filter(x => x.r.date >= last7), 200);
    log(line(`  ≥ ${Math.round(a * 100)}%`, stat(s)) + `  | 1st half ${pct(h1?.roi)}  2nd half ${pct(h2?.roi)}  last 7 days ${pct(l7?.roi)}`);
  }
  if (mode === "lodo") {
    const big = g.filter(x => x.e >= 0.25);
    log("Picks with EV ≥ 25%, broken down:");
    for (const s of [...new Set(big.map(x => x.r.stat))]) log(line(`  stat ${s}`, stat(big.filter(x => x.r.stat === s))));
    log(line("  side YES (over)", stat(big.filter(x => x.side === "yes")))); log(line("  side NO (under)", stat(big.filter(x => x.side === "no"))));
    for (const [a, b] of [[0.2, 0.3], [0.3, 0.4], [0.4, 0.5], [0.5, 0.6], [0.6, 0.8]]) log(line(`  cost ${Math.round(a * 100)}–${Math.round(b * 100)}¢`, stat(big.filter(x => x.cost - fee(x.cost) >= a && x.cost - fee(x.cost) < b))));
    log("Per day (EV ≥ 25%):");
    const byDay = {}; for (const x of big) (byDay[x.r.date] ||= []).push(x);
    log("  " + Object.keys(byDay).sort().map(d => { const s = byDay[d].reduce((a, x) => a + x.cost, 0), r = byDay[d].reduce((a, x) => a + x.hit, 0); return `${d.slice(5)} ${byDay[d].length}:${pct((r - s) / s)}`; }).join("  "));
  }
}
writeFileSync(process.argv[3] || ".cache/ev-study.txt", out.join("\n"));
