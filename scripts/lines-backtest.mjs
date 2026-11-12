#!/usr/bin/env node
/**
 * Do simple game-line rules beat Kalshi's price? Reads .cache/lines-<league>.json (scripts/college-lines.mjs)
 * and, for totals and spreads, reports calibration of the main line (the strike priced nearest 50%) and the
 * after-fee ROI of simple rules, separately for the earlier and later half of the dates (a rule only counts
 * if it wins in both halves). Prices are the real pre-game YES bid/ask; buying YES pays the ask, NO pays 1 − bid.
 *
 *   node scripts/lines-backtest.mjs ncaaf ncaamb nba
 */
import { readFileSync } from "node:fs";

const fee = p => Math.ceil(0.07 * p * (1 - p) * 100 - 1e-9) / 100;
const mid = s => (s.bid + s.ask) / 2;
const ok = s => s.ask > s.bid - 1e-9 && s.ask - s.bid <= 0.1 && s.ask > 0.02 && s.bid < 0.98;
/** Profit per contract buying `side` of strike s (1 = YES hit). */
const pnl = (s, side) => { const c = side === "yes" ? s.ask : 1 - s.bid; return { cost: c + fee(c), ret: side === "yes" ? s.y : 1 - s.y }; };

export function rules(events) {
  const R = {};
  const add = (name, half, s, side) => { if (!s || !ok(s)) return; const { cost, ret } = pnl(s, side); if (cost < 0.1 || cost > 0.95) return; const r = (R[name] ||= { h: [{ n: 0, c: 0, r: 0 }, { n: 0, c: 0, r: 0 }] }).h[half]; r.n++; r.c += cost; r.r += ret; };
  const days = [...new Set(events.map(e => e.day))].sort(), cut = days[Math.floor(days.length / 2)];
  for (const e of events) {
    const half = e.day < cut ? 0 : 1, st = e.strikes.filter(ok);
    if (!st.length) continue;
    const main = arr => arr.slice().sort((a, b) => Math.abs(mid(a) - 0.5) - Math.abs(mid(b) - 0.5))[0];
    if (e.kind === "total") {
      const m = main(st);
      add("total: under the main line", half, m, "no"); add("total: over the main line", half, m, "yes");
      for (const s of st) { if (mid(s) <= 0.2) add("total ladder: NO on long-shot overs (YES ≤ 20¢)", half, s, "no"); if (mid(s) >= 0.8) add("total ladder: YES on heavy overs (YES ≥ 80¢)", half, s, "yes"); }
    } else {
      // favorite = the side whose "wins by over X" ladder has its 50% point at the larger X
      const homeS = st.filter(s => s.home === 1), awayS = st.filter(s => s.home === 0);
      const mh = homeS.length ? main(homeS) : null, ma = awayS.length ? main(awayS) : null;
      const fav = mh && (!ma || Math.abs(mid(mh) - 0.5) <= Math.abs(mid(ma) - 0.5)) ? mh : ma;
      if (fav) { add("spread: favorite covers (main line)", half, fav, "yes"); add("spread: underdog covers (main line)", half, fav, "no"); if (fav.x >= 10) { add("spread: big favorite (10+) covers", half, fav, "yes"); add("spread: big underdog (10+) covers", half, fav, "no"); } }
      for (const s of st) if (mid(s) <= 0.2) add("spread ladder: NO on long-shot blowouts (YES ≤ 20¢)", half, s, "no");
    }
  }
  return { cut, R };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const lg of process.argv.slice(2)) {
    let db; try { db = JSON.parse(readFileSync(`.cache/lines-${lg}.json`, "utf8")); } catch { console.log(lg, "no data"); continue; }
    const ev = Object.values(db.events);
    const tot = ev.filter(e => e.kind === "total"), spr = ev.filter(e => e.kind === "spread");
    // calibration of the main total line
    const mains = tot.map(e => { const st = e.strikes.filter(ok); return st.length ? { e, s: st.sort((a, b) => Math.abs(mid(a) - 0.5) - Math.abs(mid(b) - 0.5))[0] } : null; }).filter(Boolean);
    const overs = mains.filter(m => m.s.y).length;
    console.log(`\n== ${lg.toUpperCase()}: ${tot.length} games with totals, ${spr.length} with spreads (${[...new Set(ev.map(e => e.day))].length} days)`);
    console.log(`main total line: overs hit ${overs}/${mains.length} (${(overs / mains.length * 100).toFixed(1)}%), priced at avg ${(mains.reduce((a, m) => a + mid(m.s), 0) / mains.length * 100).toFixed(1)}%`);
    const { cut, R } = rules(ev);
    console.log(`rule ROI after fees (1st half < ${cut} | 2nd half):`);
    for (const [name, r] of Object.entries(R)) {
      const f = h => h.n ? `${String(h.n).padStart(5)} bets ${((h.r - h.c) / h.c * 100).toFixed(1).padStart(6)}%` : "      -";
      console.log(`  ${name.padEnd(52)} ${f(r.h[0])} | ${f(r.h[1])}`);
    }
  }
}
