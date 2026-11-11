#!/usr/bin/env node
/**
 * Backtest + tuning for the PropLab edge model (site/model.js).
 *
 * Replays every past game in site/data.json: for each player/stat/game it rebuilds the player as
 * he looked the morning of that game (only older games, defense-vs-position from earlier games
 * only), projects, prices a line near his recent median (and ±1 alternates), and scores the
 * prediction against what happened.
 *
 *   node scripts/backtest-model.mjs            # report only (site/model-report.json)
 *   node scripts/backtest-model.mjs --tune     # also search settings per league and print PARAMS
 *
 * Metrics: MAE of the projected mean, log loss and Brier score of P(over), calibration bins.
 * Tuning uses the earlier 70% of game dates; all reported "test" numbers are the later 30%.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const M = require("../site/model.js");


const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const median = a => { const s = [...a].sort((x, y) => x - y), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0; };
const days = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400e3);
const MIN_PRIOR = { nfl: 6 };

function posGroup(league, pos) {
  pos = (pos || "").toUpperCase();
  if (league === "nba") return /C/.test(pos) ? "C" : /F/.test(pos) ? "F" : "G";
  if (league === "nhl") return pos === "D" ? "D" : pos === "G" ? "G" : "F";
  if (league === "nfl") return ["QB", "RB", "WR", "TE"].includes(pos) ? pos : "OTH";
  return pos;
}

/** Point-in-time defense vs position: ratios recorded per (group, opp, stat) with their dates. */
function dvpIndex(league, players, stats) {
  const idx = {};
  for (const p of players) {
    const g = posGroup(league, p.pos);
    const bySeason = {};
    for (const l of p.logs) (bySeason[l.season] ||= []).push(l);
    for (const logs of Object.values(bySeason)) for (const s of stats) {
      const m = mean(logs.map(l => l.stats[s] ?? 0)); if (!m) continue;
      for (const l of logs) (((idx[g] ||= {})[l.opp] ||= {})[s] ||= []).push({ date: l.date, season: l.season, r: (l.stats[s] ?? 0) / m });
    }
  }
  return (g, opp, stat, date, season) => {
    const a = (idx[g]?.[opp]?.[stat] || []).filter(x => x.season === season && x.date < date);
    return a.length >= 4 ? { f: mean(a.map(x => x.r)), n: a.length } : null;
  };
}

/** Build every evaluation case once per league: the pseudo-player, the stat, the lines and the outcome. */
function buildCases(league, sport) {
  const stats = sport.stats.map(s => s.key);
  const dvp = dvpIndex(league, sport.players, stats);
  const minPrior = MIN_PRIOR[league] || 10, cases = [];
  for (const p of sport.players) {
    const logs = p.logs || [];
    for (let j = 0; j + minPrior < logs.length; j++) {
      const g = logs[j], prior = logs.slice(j + 1);
      if (prior[0].season !== g.season && prior.length < 15) continue;
      const restDays = Math.max(0, days(g.date, prior[0].date) - 1);
      for (const stat of stats) {
        if (g.stats?.[stat] == null) continue;
        const recent = prior.slice(0, 15).map(l => l.stats?.[stat] ?? 0);
        if (mean(recent) < 0.15) continue; // nobody posts a line on a stat he never records
        const d = dvp(posGroup(league, p.pos), g.opp, stat, g.date, g.season);
        const pp = { pos: p.pos, logs: prior, home: g.home, opp: g.opp, restDays, withWithout: [], game: {},
          dvp: d ? { group: posGroup(league, p.pos), factor: { [stat]: d.f }, n: { [stat]: d.n }, rank: {}, of: 0 } : null };
        // main line near his median, ±1, and alternate-ladder strikes ±0.5 and ±1 standard deviation away
        const base = Math.floor(median(recent)) + 0.5, sdv = Math.sqrt(mean(recent.map(v => (v - mean(recent)) ** 2)));
        const alt = [0.5, 1].flatMap(k => [base - Math.round(k * sdv), base + Math.round(k * sdv)]);
        const lines = [...new Set([base - 1, base, base + 1, ...alt].filter(x => x > 0))];
        cases.push({ p: pp, stat, actual: g.stats[stat], lines, main: base, date: g.date });
      }
    }
  }
  return cases;
}

function score(cases, league, over) {
  let ae = 0, n = 0, ll = 0, br = 0, m = 0, aeBase = 0, llEmp = 0, llMain = 0, nMain = 0, bias = 0;
  const bins = Array.from({ length: 10 }, () => ({ n: 0, p: 0, hit: 0 }));
  const preds = [], byConf = {};
  for (const c of cases) {
    const proj = M.project(c.p, c.stat, league, over); if (!proj) continue;
    ae += Math.abs(proj.mean - c.actual); n++;
    aeBase += Math.abs(mean(c.p.logs.slice(0, 10).map(l => l.stats?.[c.stat] ?? 0)) - c.actual);
    for (const line of c.lines) {
      const pr = M.probabilities(c.p, c.stat, line, proj, league, over);
      const y = c.actual > line ? 1 : 0, q = Math.min(0.99, Math.max(0.01, pr.over));
      ll -= y ? Math.log(q) : Math.log(1 - q); br += (q - y) ** 2; m++;
      if (line === c.main) {
        llMain -= y ? Math.log(q) : Math.log(1 - q); nMain++; bias += q - y;
        const g = M.confidence ? M.confidence(c.p, c.stat, league, proj)?.grade : null;
        if (g) { const b = (byConf[g] ||= { n: 0, ex: 0 }); b.n++; b.ex += -(y ? Math.log(q) : Math.log(1 - q)) + (q * Math.log(q) + (1 - q) * Math.log(1 - q)); }
      }
      const e = Math.min(0.99, Math.max(0.01, pr.empirical)); llEmp -= y ? Math.log(e) : Math.log(1 - e);
      const b = bins[Math.min(9, Math.floor(q * 10))]; b.n++; b.p += q; b.hit += y;
      preds.push({ raw: pr.raw, y });
    }
  }
  const confidence = Object.fromEntries(["High", "Medium", "Low"].filter(g => byConf[g]).map(g => { const b = byConf[g]; return [g, { props: b.n, excessLoss: +(b.ex / b.n).toFixed(4) }]; }));
  return { cases: n, props: m, confidence, mainLine: { props: nMain, logLoss: llMain / nMain, bias: bias / nMain }, mae: ae / n, maeL10: aeBase / n, logLoss: ll / m, logLossHitRate: llEmp / m, brier: br / m,
    calibration: bins.filter(b => b.n).map((b, i) => ({ bin: `${i * 10}-${i * 10 + 10}%`, n: b.n, predicted: +(b.p / b.n).toFixed(3), actual: +(b.hit / b.n).toFixed(3) })), preds };
}

/**
 * Recalibration logit(p') = a·logit(p), slope only, by Newton's method. The slope fixes over/under-
 * confidence. No intercept: in a backtest the over rate at a "median" line depends on how the
 * line was synthesized and drifts by season, while real lines come from the market.
 */
function fitCalibration(preds) {
  let a = 1;
  const xs = preds.map(r => M.logit(Math.min(0.995, Math.max(0.005, r.raw))));
  for (let it = 0; it < 30; it++) {
    let g = 0, h = 0;
    preds.forEach((r, i) => { const x = xs[i], q = M.sigmoid(a * x); g += (q - r.y) * x; h += q * (1 - q) * x * x; });
    if (!h) break; const d = g / h; a -= d; if (Math.abs(d) < 1e-7) break;
  }
  return { calA: +a.toFixed(3) };
}

const GRID = {
  halfLife: [3, 5, 8, 12, 18, 30],
  prevSeason: [0.3, 0.6, 1],
  window: [15, 20, 30, 40],
  longShrink: [0, 0.1, 0.2, 0.35, 0.5],
  minutesWeight: [0, 0.5, 1],
  dvpWeight: [0, 0.3, 0.6, 1],
  venueWeight: [0, 0.3, 0.6, 1],
  restWeight: [0, 0.5, 1],
  sdShrink: [0, 0.25, 0.5, 0.75, 1],
  cv: [0.25, 0.3, 0.35, 0.45, 0.55, 0.7],
  countDisp: [1, 1.1, 1.2, 1.4, 1.7, 2],
  skew: [0, 1],
  empWeight: [0, 0.1, 0.25, 0.4],
};

/**
 * Coordinate descent on log loss. The training dates are cut into three chronological blocks and
 * a setting only changes if it helps in every block, which keeps small leagues (NFL) from chasing
 * noise or one season's quirks.
 */
function tune(league, train, start) {
  const cur = { ...M.DEFAULT, calA: 1, calB: 0, ...(start || {}) };
  const dates = [...new Set(train.map(c => c.date))].sort();
  const cuts = [dates[Math.floor(dates.length / 3)], dates[Math.floor(dates.length * 2 / 3)]];
  const blocks = [train.filter(c => c.date < cuts[0]), train.filter(c => c.date >= cuts[0] && c.date < cuts[1]), train.filter(c => c.date >= cuts[1])];
  const evalAll = o => blocks.map(b => score(b, league, o).logLoss);
  let best = evalAll(cur);
  for (let round = 0; round < 3; round++) {
    let moved = false;
    for (const [k, vals] of Object.entries(GRID)) for (const v of vals) {
      if (v === cur[k]) continue;
      const o = { ...cur, [k]: v }, r = evalAll(o);
      if (!r.every((x, i) => x < best[i] - 1e-5)) continue;
      best = r; cur[k] = v; moved = true;
    }
    if (!moved) break;
  }
  // calibration: fitted on the first two blocks, kept only if it also improves the third
  const trial = { ...cur, ...fitCalibration(score([...blocks[0], ...blocks[1]], league, cur).preds) };
  if (score(blocks[2], league, trial).logLoss >= best[2] - 1e-5) return cur;
  return { ...cur, ...fitCalibration(score(train, league, cur).preds) };
}

export const strip = s => { const { preds, ...rest } = s; rest.mainLine = { props: s.mainLine.props, logLoss: +s.mainLine.logLoss.toFixed(4), bias: +s.mainLine.bias.toFixed(4) }; for (const k of ["mae", "maeL10", "logLoss", "logLossHitRate", "brier"]) rest[k] = +rest[k].toFixed(4); return rest; };
/** Split one league's cases by date: earlier 70% to tune on, later 30% to test. */
export function split(cases) {
  const dates = [...new Set(cases.map(c => c.date))].sort(), cut = dates[Math.floor(dates.length * 0.7)];
  return { cut, train: cases.filter(c => c.date < cut), test: cases.filter(c => c.date >= cut) };
}

export { buildCases, score, tune, fitCalibration, GRID, dvpIndex, posGroup };

if (import.meta.url === `file://${process.argv[1]}`) {
  const TUNE = process.argv.includes("--tune");
  const DATA = process.argv.find(a => a.endsWith(".json")) || "site/data.json";
  const data = JSON.parse(readFileSync(DATA, "utf8"));
  const report = { generated: new Date().toISOString(), source: data.generated, method: "Walk-forward replay: each game predicted from only the games before it. Lines at the player's recent median (x.5), ±1, and alternate strikes ±0.5 and ±1 standard deviation away. Settings tuned on the earlier 70% of dates; numbers below are the later 30%.", leagues: {} };
  const tuned = {};

  for (const [league, sport] of Object.entries(data.sports)) {
    const cases = buildCases(league, sport);
    if (cases.length < 200) { console.log(league, "too few cases", cases.length); continue; }
    const { cut, train, test } = split(cases);
    const params = TUNE ? tune(league, train) : M.cfg(league);
    const before = score(test, league, { ...M.DEFAULT, calA: 1, calB: 0 });
    const after = score(test, league, params);
    const changed = Object.fromEntries(Object.entries(params).filter(([k, v]) => M.DEFAULT[k] !== v));
    tuned[league] = changed;
    report.leagues[league] = { train: train.length, test: test.length, split: cut, defaults: strip(before), tuned: strip(after) };
    console.log(`${league}: test ${test.length} cases | logloss ${before.logLoss.toFixed(4)} → ${after.logLoss.toFixed(4)} (hit-rate only ${after.logLossHitRate.toFixed(4)}) | brier ${before.brier.toFixed(4)} → ${after.brier.toFixed(4)} | main-line LL ${before.mainLine.logLoss.toFixed(4)} → ${after.mainLine.logLoss.toFixed(4)} bias ${after.mainLine.bias.toFixed(3)} | MAE ${before.mae.toFixed(3)} → ${after.mae.toFixed(3)} (L10 avg ${after.maeL10.toFixed(3)})`);
  }
  if (TUNE) console.log("PARAMS =", JSON.stringify(tuned));
  writeFileSync("site/model-report.json", JSON.stringify(report, null, 1));
  console.log("wrote site/model-report.json");
}
