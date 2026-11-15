#!/usr/bin/env node
/**
 * Are early Kalshi NFL prop prices beatable? For each time before kickoff (scripts/nfl-early.mjs), checks
 * (1) how accurate the price was then, (2) whether player stats (ESPN, earlier games only) add information
 * on top of that early price, out of sample (leave-one-week-out and strictly forward), and (3) the Edge
 * Board's pick rule after fees at that early price, split into halves. Results come from Kalshi.
 *
 *   node scripts/nfl-early-study.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
const { logistic } = await import("./market-fit.mjs");
const { OFFSETS } = await import("./nfl-early.mjs");
const read = f => JSON.parse(readFileSync(f, "utf8"));
const norm = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, "").replace(/[^a-z]/g, "");
const fee = p => Math.ceil(0.07 * p * (1 - p) * 100 - 1e-9) / 100, clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lg = p => { p = clamp(p, 0.01, 0.99); return Math.log(p / (1 - p)); }, sig = x => 1 / (1 + Math.exp(-x));
const LL = (p, y) => -(y ? Math.log(clamp(p, 1e-4, 1)) : Math.log(clamp(1 - p, 1e-4, 1)));
const week = d => Math.floor((Date.parse(d) - Date.parse("2026-09-08")) / 6048e5);
const n = v => { const x = parseFloat(v); return Number.isFinite(x) ? x : 0; };
const STAT = {
  KXNFLPASSYDS: r => n(r.passingYards), KXNFLPASSTDS: r => n(r.passingTouchdowns), KXNFLPASSATT: r => n(r.passingAttempts), KXNFLPASSCOMP: r => n(r.completions),
  KXNFLPASSINT: r => n(r.interceptions), KXNFLRSHYDS: r => n(r.rushingYards), KXNFLRSHATT: r => n(r.rushingAttempts), KXNFLRECYDS: r => n(r.receivingYards),
  KXNFLREC: r => n(r.receptions), KXNFLRRYDS: r => n(r.rushingYards) + n(r.receivingYards), KXNFLTD: r => n(r.rushingTouchdowns) + n(r.receivingTouchdowns),
  KXNFLLONGREC: r => n(r.longReception), KXNFLLONGRSH: r => n(r.longRushing),
};
const has = (r, s) => s.startsWith("KXNFLPASS") ? r.passingAttempts != null : /REC/.test(s) && !/RRYDS/.test(s) ? r.receptions != null || r.receivingTargets != null : true;

const ev = {};
for (const f of readdirSync(".cache").filter(f => /^nfl-deep(-\d)?\.json$/.test(f))) Object.assign(ev, read(`.cache/${f}`).events);
for (const [k, e] of Object.entries(read(".cache/kalshi-history-nfl.json").events)) ev[k] = { series: e.series, date: e.date, markets: e.markets.map(m => ({ ...m, yt: `${m.name}: ${m.n}+` })) };
const early = {}; for (const f of readdirSync(".cache").filter(f => /^nfl-early-\d\.json$/.test(f))) Object.assign(early, read(`.cache/${f}`));
const P = new Map(read(".cache/nfl-players.json").players.map(p => [norm(p.name), p]));

const rows = [];
for (const [k, e] of Object.entries(ev)) {
  const f = STAT[e.series], snaps = early[k]; if (!f || !snaps || snaps.err) continue;
  for (const m of e.markets) {
    const s = snaps[m.tk]; if (!s) continue;
    const name = String(m.yt || "").split(":")[0].trim(), p = P.get(norm(name)); if (!p) continue;
    const strike = m.strike ?? (() => { const x = /(\d+(?:\.\d+)?)\+/.exec(m.yt || ""); return x ? +x[1] - 0.5 : null; })(); if (strike == null) continue;
    const prior = p.logs.filter(l => l.date < e.date && has(l.raw, e.series)); if (prior.length < 4) continue;
    const xs = prior.slice(0, 10).map(l => f(l.raw)), mu = xs.reduce((a, x) => a + x, 0) / xs.length, sd = Math.sqrt(xs.reduce((a, x) => a + (x - mu) ** 2, 0) / (xs.length - 1)) || 1;
    const pEmp = (xs.filter(x => x > strike).length + 0.5) / (xs.length + 1), pNorm = sig(1.7 * (mu - strike) / Math.max(sd, 1));
    rows.push({ s: e.series, w: week(e.date), y: m.y, key: `${k}|${norm(name)}`, snaps: s, pEmp, pNorm });
  }
}
const weeks = [...new Set(rows.map(r => r.w))].sort((a, b) => a - b), half = weeks[Math.floor(weeks.length / 2)];
console.log(`${rows.length} prop markets with early prices and ≥4 earlier games, ${weeks.length} weeks`);
const roi = b => { if (!b.length) return "    —"; const c = b.reduce((a, x) => a + x.cost, 0); return `${String(b.length).padStart(5)} bets ${(((b.reduce((a, x) => a + x.hit, 0) - c) / c) * 100).toFixed(1).padStart(6)}%`; };

console.log("\nhours before kickoff | markets | log loss: price → price+stats (leave-one-week-out / forward) | board rule after fees (forward fit): EV ≥ 5% · ≥ 10% (1st half | 2nd half)");
OFFSETS.forEach((h, oi) => {
  const R = rows.map(r => { const q = r.snaps[oi]; if (!q || q[1] - q[0] > 0.10) return null; const mid = (q[0] + q[1]) / 2; return mid > 0.03 && mid < 0.97 ? { ...r, bid: q[0], ask: q[1], mid } : null; }).filter(Boolean);
  if (R.length < 2000) { console.log(`  ${String(h).padStart(3)} h: only ${R.length} markets`); return; }
  const X = r => [1, lg(r.mid), lg(r.pEmp) - lg(r.mid), lg(r.pNorm) - lg(r.mid)], X0 = r => [1, lg(r.mid)];
  const qL = [], qF = [], q0F = [];
  for (const w of weeks) {
    const tr = R.filter(r => r.w !== w), b = logistic(tr.map(X), tr.map(r => r.y), 5);
    const past = R.filter(r => r.w < w), ok = new Set(past.map(r => r.w)).size >= 3, bf = ok ? logistic(past.map(X), past.map(r => r.y), 5) : null, b0 = ok ? logistic(past.map(X0), past.map(r => r.y), 5) : null;
    R.forEach((r, i) => { if (r.w !== w) return; qL[i] = sig(X(r).reduce((a, v, j) => a + v * b[j], 0)); qF[i] = bf ? sig(X(r).reduce((a, v, j) => a + v * bf[j], 0)) : null; q0F[i] = b0 ? sig(X0(r).reduce((a, v, j) => a + v * b0[j], 0)) : null; });
  }
  const fw = R.map((_, i) => i).filter(i => qF[i] != null), ll = (f, I) => I.reduce((a, i) => a + LL(f(i), R[i].y), 0) / I.length, all = R.map((_, i) => i);
  const board = (q, t) => { const best = new Map(); R.forEach((r, i) => { if (q[i] == null) return; for (const side of ["yes", "no"]) { const c = side === "yes" ? r.ask : 1 - r.bid; if (c < 0.2 || c > 0.8) continue;
    const cost = c + fee(c), e = (side === "yes" ? q[i] : 1 - q[i]) / cost - 1; if (e < t) continue; const k = r.key + r.s, o = best.get(k); if (!o || e > o.e) best.set(k, { e, cost, hit: side === "yes" ? r.y : 1 - r.y, w: r.w }); } }); return [...best.values()]; };
  const b5 = board(qF, 0.05), b10 = board(qF, 0.10);
  console.log(`  ${String(h).padStart(3)} h  ${String(R.length).padStart(6)}  mid ${ll(i => R[i].mid, all).toFixed(4)} → ${ll(i => qL[i], all).toFixed(4)} LOWO | fwd mid ${ll(i => R[i].mid, fw).toFixed(4)}, recal ${ll(i => q0F[i], fw).toFixed(4)}, +stats ${ll(i => qF[i], fw).toFixed(4)} | ≥5%: ${roi(b5)} (${roi(b5.filter(x => x.w < half))} | ${roi(b5.filter(x => x.w >= half))}) · ≥10%: ${roi(b10)} (${roi(b10.filter(x => x.w < half))} | ${roi(b10.filter(x => x.w >= half))})`);
});
