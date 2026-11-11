#!/usr/bin/env node
/**
 * Fits the final edge layer on real Kalshi results: a logistic regression that starts from the
 * market's own price and only moves off it for variables that earned it out of sample.
 *
 *   logit P(yes) = b0 + b1·logit(mid) + Σ bk·feature_k
 *
 * Validation is leave-one-day-out (all strikes of a game share a day, so they never straddle the
 * split). A variable is kept only if it lowers out-of-sample log loss. Prints the coefficients to
 * paste into PropModel.EDGE_FIT and the Edge Board rule's out-of-sample record.
 *
 *   node scripts/market-fit.mjs [.cache/kalshi-history.json] [site/data.json]
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { buildRows, modelProbs } from "./market-backtest.mjs";
const M = createRequire(import.meta.url)("../site/model.js");

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lg = p => Math.log(clamp(p, 0.01, 0.99) / (1 - clamp(p, 0.01, 0.99)));
const sig = x => 1 / (1 + Math.exp(-x));
const LL = (p, y) => -(y ? Math.log(clamp(p, 1e-4, 1)) : Math.log(clamp(1 - p, 1e-4, 1)));
const fee = p => Math.ceil(0.07 * p * (1 - p) * 100 - 1e-9) / 100;

/** Ridge-penalised logistic regression by Newton's method. X rows include the intercept column. */
export function logistic(X, y, lambda = 1) {
  const k = X[0].length; let b = new Array(k).fill(0); b[1] = 1;   // start at "trust the market"
  for (let it = 0; it < 50; it++) {
    const g = new Array(k).fill(0), H = Array.from({ length: k }, () => new Array(k).fill(0));
    X.forEach((x, i) => { const p = sig(x.reduce((a, v, j) => a + v * b[j], 0)), w = p * (1 - p); for (let j = 0; j < k; j++) { g[j] += (p - y[i]) * x[j]; for (let l = 0; l < k; l++) H[j][l] += w * x[j] * x[l]; } });
    for (let j = 1; j < k; j++) { const prior = j === 1 ? 1 : 0; g[j] += lambda * (b[j] - prior); H[j][j] += lambda; }
    const d = solve(H, g); b = b.map((v, j) => v - d[j]);
    if (Math.max(...d.map(Math.abs)) < 1e-8) break;
  }
  return b;
}
function solve(A, v) {
  const n = v.length, M_ = A.map((r, i) => [...r, v[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M_[r][c]) > Math.abs(M_[p][c])) p = r;
    [M_[c], M_[p]] = [M_[p], M_[c]]; const d = M_[c][c] || 1e-12;
    for (let r = 0; r < n; r++) if (r !== c) { const f = M_[r][c] / d; for (let k = c; k <= n; k++) M_[r][k] -= f * M_[c][k]; }
  }
  return M_.map((r, i) => r[n] / (r[i] || 1e-12));
}

/** Candidate variables, each computable live from data.json + the quote (see PropModel.edgeFeatures). */
export const FEATURES = ["model", "move", "spread", "minTrend", "home", "b2b", "dvp", "statPts", "statReb", "statAst", "stat3", "statCombo", "statDef", "farOver", "farUnder"];

if (import.meta.url === `file://${process.argv[1]}`) {
  const HIST = process.argv.find(a => /kalshi-history.*\.json$/.test(a)) || ".cache/kalshi-history.json";
  const DATA = process.argv.find(a => /data\.json$/.test(a)) || "site/data.json";
  const hist = JSON.parse(readFileSync(HIST, "utf8")), data = JSON.parse(readFileSync(DATA, "utf8"));
  let rows = buildRows(hist, data.sports.nba).filter(r => r.ask - r.bid <= 0.12 && r.mid > 0.03 && r.mid < 0.97);
  const probs = modelProbs(rows, M.cfg("nba"));
  rows = rows.map((r, i) => ({ ...r, pm: probs[i] })).filter(r => r.pm != null);
  const projCache = new Map();
  for (const r of rows) {
    const k = r.game + r.stat; if (!projCache.has(k)) projCache.set(k, M.project(r.p, r.stat, "nba"));
    r.f = M.edgeFeatures({ mid: r.mid, bid: r.bid, ask: r.ask, mid0: r.mid0, model: r.pm, stat: r.stat, line: r.line, proj: projCache.get(k), p: r.p });
  }
  const days = [...new Set(rows.map(r => r.date))].sort();
  console.log(`${rows.length} markets, ${new Set(rows.map(r => r.game)).size} player-games, ${days.length} days (${days[0]}…${days.at(-1)})`);
  const design = (r, feats) => [1, lg(r.mid), ...feats.map(f => r.f[f] ?? 0)];
  /** leave-one-day-out log loss and the out-of-sample probabilities */
  const cv = (feats, lambda) => {
    const out = new Array(rows.length);
    for (const d of days) {
      const tr = rows.filter(r => r.date !== d), b = logistic(tr.map(r => design(r, feats)), tr.map(r => r.y), lambda);
      rows.forEach((r, i) => { if (r.date === d) out[i] = sig(design(r, feats).reduce((a, v, j) => a + v * b[j], 0)); });
    }
    return { ll: rows.reduce((a, r, i) => a + LL(out[i], r.y), 0) / rows.length, p: out };
  };
  const llMid = rows.reduce((a, r) => a + LL(r.mid, r.y), 0) / rows.length;
  const base = cv([], 5);
  console.log(`log loss: market mid ${llMid.toFixed(4)} | recalibrated market ${base.ll.toFixed(4)} | raw model ${(rows.reduce((a, r) => a + LL(r.pm, r.y), 0) / rows.length).toFixed(4)}`);
  // forward selection
  let chosen = [], best = base.ll;
  for (;;) {
    let pick = null;
    for (const f of FEATURES.filter(f => !chosen.includes(f))) { const s = cv([...chosen, f], 5).ll; if (s < best - 0.0003 && (!pick || s < pick.s)) pick = { f, s }; }
    if (!pick) break; chosen.push(pick.f); best = pick.s; console.log(`  + ${pick.f.padEnd(10)} → ${pick.s.toFixed(4)}`);
  }
  const final = cv(chosen, 5), b = logistic(rows.map(r => design(r, chosen)), rows.map(r => r.y), 5);
  console.log("EDGE_FIT =", JSON.stringify({ n: rows.length, days: days.length, through: days.at(-1), b0: +b[0].toFixed(4), bMid: +b[1].toFixed(4), ...Object.fromEntries(chosen.map((f, j) => [f, +b[j + 2].toFixed(4)])) }));
  // what betting the out-of-sample edge would have done (best side per player/stat/game, 1 contract)
  for (const minEv of [0, 0.02, 0.04, 0.06]) {
    const best_ = new Map();
    rows.forEach((r, i) => { const q = final.p[i]; for (const side of ["yes", "no"]) { const cost = side === "yes" ? r.ask : 1 - r.bid; if (cost < 0.15 || cost > 0.85) continue; const e = (side === "yes" ? q : 1 - q) - cost - fee(cost); if (e < minEv) continue; const k = r.game + r.stat, o = best_.get(k); if (!o || e > o.e) best_.set(k, { e, cost, hit: side === "yes" ? r.y : 1 - r.y, side }); } });
    const v = [...best_.values()], st = v.reduce((a, x) => a + x.cost + fee(x.cost), 0), ret = v.reduce((a, x) => a + x.hit, 0);
    console.log(`  bets with out-of-sample EV ≥ ${minEv}: ${v.length} (${v.filter(x => x.side === "no").length} NO), won ${v.length ? (ret / v.length * 100).toFixed(1) : 0}%, ROI ${st ? ((ret - st) / st * 100).toFixed(1) : 0}%`);
  }
}
