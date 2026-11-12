/** NBA-style test on other leagues' Kalshi player props: bias for the site's players? Would the board rule win?
 *   node scripts/kalshi-history.mjs --league nfl --since 2026-09-08 --out .cache/kalshi-history-nfl.json
 *   node scripts/props-study.mjs --league nfl [site/data.json]      (nfl groups by week; nhl by day) */
import { readFileSync } from "node:fs";
const { logistic } = await import("./market-fit.mjs");
const LG = (() => { const i = process.argv.indexOf("--league"); return i > 0 ? process.argv[i + 1] : "nfl"; })();
const dataPath = process.argv.slice(2).find(a => a.endsWith(".json")) || "site/data.json";
const hist = JSON.parse(readFileSync(`.cache/kalshi-history-${LG}.json`, "utf8"));
const site = JSON.parse(readFileSync(dataPath, "utf8")).sports[LG]?.players || [];   // off-season leagues have no site players
const norm = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, "").replace(/[^a-z]/g, "");
const names = new Set(site.map(p => norm(p.name)));
const lg = p => Math.log(Math.min(.99, Math.max(.01, p)) / (1 - Math.min(.99, Math.max(.01, p)))), sig = x => 1 / (1 + Math.exp(-x));
const fee = p => Math.ceil(0.07 * p * (1 - p) * 100 - 1e-9) / 100, LL = (p, y) => -(y ? Math.log(Math.max(p, 1e-4)) : Math.log(Math.max(1 - p, 1e-4)));
// validation groups: NFL by week (Tue–Mon), other leagues by day
const week = d => { const t = Date.parse(d); return LG === "nfl" ? Math.floor((t - Date.parse("2026-09-08")) / (7 * 86400e3)) : Math.floor(t / 86400e3); };
const all = [];
for (const [ev, e] of Object.entries(hist.events)) for (const m of e.markets) {
  if (m.bid == null || m.ask == null || m.ask - m.bid > 0.12) continue;
  const mid = (m.bid + m.ask) / 2; if (mid <= 0.03 || mid >= 0.97) continue;
  all.push({ game: `${ev}|${norm(m.name)}`, stat: e.stat, week: week(e.date), date: e.date, mid, bid: m.bid, ask: m.ask, y: m.y, site: names.has(norm(m.name)) });
}
const STATS = [...new Set(all.map(r => r.stat))];
console.log(`${all.length} ${LG.toUpperCase()} prop markets with a pre-game quote (${all.filter(r => r.site).length} for the site's ${site.length} players), ${new Set(all.map(r => r.week)).size} ${LG === "nfl" ? "weeks" : "days"}, stats ${STATS.join(", ")}`);
for (const [label, rows] of [["SITE PLAYERS", all.filter(r => r.site)], ["ALL PLAYERS", all]]) {
  if (rows.length < 500) { console.log(`\n===== ${label}: only ${rows.length} markets, skipped`); continue; }
  const weeks = [...new Set(rows.map(r => r.week))].sort((a, b) => a - b);
  console.log(`\n===== ${label}: ${rows.length} markets, ${weeks.length} ${LG === "nfl" ? "weeks" : "days"}`);
  console.log("calibration (YES priced → hit), by stat:");
  for (const s of STATS) { const g = rows.filter(r => r.stat === s); if (g.length < 100) continue;
    console.log(`  ${s.padEnd(9)} n=${String(g.length).padStart(5)} ` + [[0.1, 0.3], [0.3, 0.5], [0.5, 0.7], [0.7, 0.9]].map(([a, b]) => { const h = g.filter(r => r.mid >= a && r.mid < b); return h.length >= 30 ? `${a * 100}-${b * 100}¢: ${(h.reduce((x, r) => x + r.y, 0) / h.length * 100).toFixed(0)}% (priced ${(h.reduce((x, r) => x + r.mid, 0) / h.length * 100).toFixed(0)}%)` : ""; }).join("  ")); }
  const X = r => [1, lg(r.mid), ...STATS.slice(1).map(s => r.stat === s ? 1 : 0)];
  const q = [], qf = [];
  for (const w of weeks) {
    const tr = rows.filter(r => r.week !== w), b = logistic(tr.map(X), tr.map(r => r.y), 5);
    const past = rows.filter(r => r.week < w), bf = new Set(past.map(r => r.week)).size >= (LG === "nfl" ? 3 : 5) ? logistic(past.map(X), past.map(r => r.y), 5) : null;
    rows.forEach((r, i) => { if (r.week !== w) return; q[i] = sig(X(r).reduce((a, v, j) => a + v * b[j], 0)); qf[i] = bf ? sig(X(r).reduce((a, v, j) => a + v * bf[j], 0)) : null; });
  }
  const llm = rows.reduce((a, r) => a + LL(r.mid, r.y), 0) / rows.length, llf = rows.reduce((a, r, i) => a + LL(q[i], r.y), 0) / rows.length;
  const bAll = logistic(rows.map(X), rows.map(r => r.y), 5);
  console.log(`log loss: market ${llm.toFixed(5)} vs fitted (held out) ${llf.toFixed(5)} → ${llf < llm ? "fit beats the price" : "the price is better"} | fit: b0 ${bAll[0].toFixed(3)}, bMid ${bAll[1].toFixed(3)}, ${STATS.slice(1).map((s, j) => `${s} ${bAll[j + 2].toFixed(3)}`).join(", ")}`);
  for (const [mode, qq] of [[LG === "nfl" ? "leave-one-week-out" : "leave-one-day-out", q], ["strictly forward", qf]]) {
    const best = new Map();
    rows.forEach((r, i) => { if (qq[i] == null) return; for (const side of ["yes", "no"]) { const c = side === "yes" ? r.ask : 1 - r.bid; if (c < 0.2 || c > 0.8) continue; const cost = c + fee(c), e = (side === "yes" ? qq[i] : 1 - qq[i]) / cost - 1; const k = r.game + r.stat, o = best.get(k); if (!o || e > o.e) best.set(k, { e, cost, hit: side === "yes" ? r.y : 1 - r.y, side, r }); } });
    const P = [...best.values()], half = weeks[Math.floor(weeks.length / 2)];
    const f = g => { if (!g.length) return "—"; const s = g.reduce((a, x) => a + x.cost, 0), w = g.reduce((a, x) => a + x.hit, 0); return `${String(g.length).padStart(5)} bets ROI ${(((w - s) / s) * 100).toFixed(1).padStart(6)}%`; };
    console.log(`board rule (${mode}):`);
    for (const a of [0.02, 0.10, 0.15, 0.25]) { const g = P.filter(x => x.e >= a); console.log(`  EV ≥ ${String(Math.round(a * 100)).padStart(2)}%: ${f(g)} | 1st half ${f(g.filter(x => x.r.week < half))} | 2nd half ${f(g.filter(x => x.r.week >= half))} | NO share ${g.length ? Math.round(g.filter(x => x.side === "no").length / g.length * 100) : 0}%`); }
  }
}
