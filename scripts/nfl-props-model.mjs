#!/usr/bin/env node
/**
 * Do NFL player stats beat Kalshi's prop prices? For every settled Kalshi NFL player prop with a pre-kickoff
 * quote, the player's games strictly before that date (ESPN, scripts/nfl-players.mjs) give simple
 * projections; a fitted layer on top of Kalshi's price (logit(mid) + stat signals) is scored leave-one-week-out
 * and strictly forward, then the Edge Board's pick rule after fees, split into halves.
 *
 *   node scripts/nfl-props-model.mjs
 * The join is by name and date only, never on the outcome (see the 2026-11-13 correction).
 */
import { readFileSync, readdirSync } from "node:fs";
const { logistic } = await import("./market-fit.mjs");
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
const has = (r, s) => s.startsWith("KXNFLPASS") ? r.passingAttempts != null : s === "KXNFLREC" || s === "KXNFLRECYDS" || s === "KXNFLLONGREC" ? r.receptions != null || r.receivingTargets != null : true;

// markets: kalshi-history-nfl (5 series) + nfl-deep (the rest)
const ev = {};
for (const f of readdirSync(".cache").filter(f => /^nfl-deep(-\d)?\.json$/.test(f))) Object.assign(ev, read(`.cache/${f}`).events);
for (const [k, e] of Object.entries(read(".cache/kalshi-history-nfl.json").events)) ev[k] = { series: e.series, date: e.date, markets: e.markets.map(m => ({ ...m, yt: `${m.name}: ${m.n}+` })) };
const P = new Map(read(".cache/nfl-players.json").players.map(p => [norm(p.name), p]));

// opponent defense: what each team allowed to a position in each stat, from every player's log (earlier weeks only)
const allowed = new Map();   // `${opp}|${pos}|${series}` → [{ date, v }]
for (const p of P.values()) for (const l of p.logs) if (/2026/.test(l.season)) for (const [s, f] of Object.entries(STAT)) { if (!has(l.raw, s)) continue; const k = `${l.opp}|${p.pos}|${s}`; (allowed.get(k) || allowed.set(k, []).get(k)).push({ date: l.date, v: f(l.raw) }); }
const defFactor = (opp, pos, s, date) => {   // team's allowed per-player average vs the league's, before date (shrunk)
  const mine = (allowed.get(`${opp}|${pos}|${s}`) || []).filter(x => x.date < date); if (!mine.length) return 0;
  let tot = 0, cnt = 0; for (const [k, v] of allowed) if (k.endsWith(`|${pos}|${s}`)) for (const x of v) if (x.date < date) { tot += x.v; cnt++; }
  const lgAvg = tot / cnt, m = mine.reduce((a, x) => a + x.v, 0) / mine.length; return lgAvg > 0 ? Math.log(((m * mine.length + lgAvg * 20) / (mine.length + 20)) / lgAvg) : 0; };
const defCache = new Map(), def = (...a) => { const k = a.join("|"); if (!defCache.has(k)) defCache.set(k, defFactor(...a)); return defCache.get(k); };
const ALIAS = { WSH: ["WAS", "WSH"], LAR: ["LA", "LAR"], JAX: ["JAC", "JAX"] };
// key teammate out: a same-team, same-group teammate with more volume over the last 3 games who played the previous
// game but has no log for this one (inactives are public ~90 min before kickoff, before the last pre-game quote)
const byTeam = new Map(); for (const p of P.values()) (byTeam.get(p.team) || byTeam.set(p.team, []).get(p.team)).push(p);
const grp = pos => pos === "QB" ? "QB" : pos === "RB" || pos === "FB" ? "RB" : "WRTE";
const volOf = (l, g) => g === "QB" ? n(l.raw.passingAttempts) : g === "RB" ? n(l.raw.rushingAttempts) + n(l.raw.receivingTargets) : n(l.raw.receivingTargets);
const addD = (d, k) => new Date(Date.parse(d) + k * 86400e3).toISOString().slice(0, 10);
const mateOut = (p, date) => { const g = grp(p.pos), mine = p.logs.filter(l => l.date < date).slice(0, 3), myVol = mine.reduce((a, l) => a + volOf(l, g), 0) / Math.max(1, mine.length);
  for (const q of byTeam.get(p.team) || []) { if (q === p || grp(q.pos) !== g) continue;
    const prev = q.logs.filter(l => l.date < date); if (!prev.length || Date.parse(date) - Date.parse(prev[0].date) > 9 * 86400e3) continue;   // played the previous week
    const v = prev.slice(0, 3).reduce((a, l) => a + volOf(l, g), 0) / Math.min(3, prev.length);
    if (v > myVol && v >= (g === "QB" ? 20 : 5) && !q.logs.some(l => l.date === date || l.date === addD(date, 1))) return 1; }
  return 0; };
const rows = []; let noPlayer = 0;
for (const [k, e] of Object.entries(ev)) {
  const f = STAT[e.series]; if (!f) continue;
  for (const m of e.markets) {
    if (m.bid == null || m.ask == null || m.ask - m.bid > 0.10) continue;
    const mid = (m.bid + m.ask) / 2; if (mid <= 0.03 || mid >= 0.97) continue;
    const name = String(m.yt || "").split(":")[0].trim(), p = P.get(norm(name)); if (!p) { noPlayer++; continue; }
    const strike = m.strike ?? (() => { const x = /(\d+(?:\.\d+)?)\+/.exec(m.yt || ""); return x ? +x[1] - 0.5 : null; })(); if (strike == null) continue;
    const prior = p.logs.filter(l => l.date < e.date && has(l.raw, e.series));   // strictly earlier games
    if (prior.length < 4) continue;
    const xs = prior.slice(0, 10).map(l => f(l.raw)), cur = prior.filter(l => /2026/.test(l.season)).slice(0, 10).map(l => f(l.raw)), l3 = xs.slice(0, 3);
    const mean = a => a.reduce((s, x) => s + x, 0) / a.length, mu = mean(xs), sd = Math.sqrt(xs.reduce((s, x) => s + (x - mu) ** 2, 0) / (xs.length - 1)) || 1;
    const pEmp = (xs.filter(x => x > strike).length + 0.5 * 1) / (xs.length + 1), z = (mu - strike) / Math.max(sd, 1);
    const pNorm = sig(1.7 * z), pRecent = (l3.filter(x => x > strike).length + 0.5) / 4, muCur = cur.length >= 3 ? mean(cur) : mu;
    const suf = k.split("-")[1].slice(7), mineT = ALIAS[p.team] || [p.team], rest = mineT.reduce((x, c) => x.replace(c, ""), suf);
    const opp = [...new Set(P.values())].length && [...new Set([...P.values()].map(q => q.team))].find(t => t !== p.team && (ALIAS[t] || [t]).some(c => rest === c));
    const dF = opp ? def(opp, p.pos, e.series, e.date) : 0;
    rows.push({ mate: mateOut(p, e.date), vol: m.vol ?? 0, dF,   // pre-game volume only: total volume includes in-game trading, which depends on the outcome
      s: e.series, ev: k, w: week(e.date), y: m.y, bid: m.bid, ask: m.ask, mid, strike, pEmp, pNorm, pRecent, zCur: (muCur - strike) / Math.max(sd, 1), n: xs.length, key: `${k}|${norm(name)}` });
  }
}
{ const vi = process.argv.indexOf("--vol"); if (vi > 0) { const v = rows.map(r => r.vol).sort((a, b) => a - b), t1 = v[Math.floor(v.length / 3)], t2 = v[Math.floor(2 * v.length / 3)], want = process.argv[vi + 1];
  const keep = rows.filter(r => want === "low" ? r.vol <= t1 : want === "high" ? r.vol > t2 : r.vol > t1 && r.vol <= t2); rows.length = 0; rows.push(...keep); console.log(`volume subset ${want}: ${rows.length} markets (terciles at ${Math.round(t1)} / ${Math.round(t2)} contracts)`); } }
const weeks = [...new Set(rows.map(r => r.w))].sort((a, b) => a - b);
console.log(`key teammate out in ${rows.filter(r => r.mate).length} markets; opponent found for ${rows.filter(r => r.dF !== 0).length} of ${rows.length} markets`);
console.log(`${rows.length} NFL prop markets with a pre-game quote and ≥4 earlier games (${new Set(rows.map(r => r.key)).size} player-games, ${weeks.length} weeks; ${noPlayer} markets without an ESPN match)`);
console.log("by series:", Object.entries(rows.reduce((a, r) => (a[r.s] = (a[r.s] || 0) + 1, a), {})).map(([k, v]) => `${k.replace("KXNFL", "")} ${v}`).join(", "));

// does the player signal know anything the price doesn't? fitted layers, scored out of sample
const MODELS = {
  "price only": r => [1, lg(r.mid)],
  "price + hit rate (last 10)": r => [1, lg(r.mid), lg(r.pEmp) - lg(r.mid)],
  "price + average vs line": r => [1, lg(r.mid), lg(r.pNorm) - lg(r.mid)],
  "price + recent 3 games": r => [1, lg(r.mid), lg(r.pRecent) - lg(r.mid)],
  "price + opponent defense": r => [1, lg(r.mid), r.dF],
  "price + key teammate out": r => [1, lg(r.mid), r.mate, r.mate * lg(r.mid)],
  "price + all player signals": r => [1, lg(r.mid), lg(r.pEmp) - lg(r.mid), lg(r.pNorm) - lg(r.mid), lg(r.pRecent) - lg(r.mid), r.zCur, r.dF],
};
const out = {};
for (const [name, X] of Object.entries(MODELS)) {
  const qL = [], qF = [];
  for (const w of weeks) {
    const tr = rows.filter(r => r.w !== w), b = logistic(tr.map(X), tr.map(r => r.y), 5);
    const past = rows.filter(r => r.w < w), bf = new Set(past.map(r => r.w)).size >= 3 ? logistic(past.map(X), past.map(r => r.y), 5) : null;
    rows.forEach((r, i) => { if (r.w !== w) return; qL[i] = sig(X(r).reduce((a, v, j) => a + v * b[j], 0)); qF[i] = bf ? sig(X(r).reduce((a, v, j) => a + v * bf[j], 0)) : null; });
  }
  const fw = rows.map((_, i) => i).filter(i => qF[i] != null);
  out[name] = { qL, qF, ll: rows.reduce((a, r, i) => a + LL(qL[i], r.y), 0) / rows.length, llF: fw.reduce((a, i) => a + LL(qF[i], rows[i].y), 0) / fw.length, llMidF: fw.reduce((a, i) => a + LL(rows[i].mid, rows[i].y), 0) / fw.length,
    coef: logistic(rows.map(X), rows.map(r => r.y), 5) };
}
const llMid = rows.reduce((a, r) => a + LL(r.mid, r.y), 0) / rows.length;
console.log(`\nlog loss (lower is better). Kalshi mid: ${llMid.toFixed(5)} (forward weeks: ${out["price only"].llMidF.toFixed(5)})`);
for (const [k, o] of Object.entries(out)) console.log(`  ${k.padEnd(30)} leave-one-week-out ${o.ll.toFixed(5)} | forward ${o.llF.toFixed(5)} | coefficients ${o.coef.map(c => c.toFixed(3)).join(", ")}`);

// the board's rule: per player-game-series, best side/strike by EV after fees
const board = (q, minEv) => { const best = new Map();
  rows.forEach((r, i) => { if (q[i] == null) return; for (const side of ["yes", "no"]) { const c = side === "yes" ? r.ask : 1 - r.bid; if (c < 0.2 || c > 0.8) continue;
    const cost = c + fee(c), e = (side === "yes" ? q[i] : 1 - q[i]) / cost - 1; if (e < minEv) continue; const k = r.key + r.s, o = best.get(k); if (!o || e > o.e) best.set(k, { e, cost, hit: side === "yes" ? r.y : 1 - r.y, w: r.w, side }); } });
  return [...best.values()]; };
const roi = b => { if (!b.length) return "    —"; const s = b.reduce((a, x) => a + x.cost, 0); return `${String(b.length).padStart(5)} bets ${(((b.reduce((a, x) => a + x.hit, 0) - s) / s) * 100).toFixed(1).padStart(6)}%`; };
const half = weeks[Math.floor(weeks.length / 2)];
for (const [k, o] of Object.entries(out)) { if (k === "price only") continue;
  console.log(`\n${k}: Edge Board rule after fees (1st half = weeks < ${half})`);
  for (const [mode, q] of [["leave-one-week-out", o.qL], ["strictly forward", o.qF]]) for (const t of [0.03, 0.05, 0.10, 0.25]) {
    const b = board(q, t); console.log(`  ${mode.padEnd(19)} EV ≥ ${String(t * 100).padStart(2)}%: ${roi(b)} | 1st half ${roi(b.filter(x => x.w < half))} | 2nd half ${roi(b.filter(x => x.w >= half))} | NO ${b.length ? Math.round(b.filter(x => x.side === "no").length / b.length * 100) : 0}%`); } }
