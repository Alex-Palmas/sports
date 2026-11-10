#!/usr/bin/env node
/**
 * Daily auto-tuning of the edge model (run by the scheduled tuning session, or by hand).
 *
 *   node scripts/auto-tune.mjs [--ledger path/to/track.json] [--apply]
 *
 * 1. Backtest: re-tunes each league's settings starting from the current ones (walk-forward,
 *    three-block consistency rule) and keeps the result only if it beats the current settings on
 *    the held-out later dates: log loss at least MIN_GAIN better, main-line log loss not worse.
 * 2. Live ledger (graded real lines): refits the market weight used for EV once a league has
 *    LEDGER_MIN graded props, moving at most MAX_STEP per day toward the best-scoring weight.
 * 3. Reports what the ledger says about confidence (excess loss and bet ROI per reason/grade),
 *    which the tuning session reviews before changing any confidence penalty by hand.
 *
 * Without --apply nothing is written. With --apply, PARAMS in site/model.js is rewritten,
 * site/model-report.json regenerated, and an entry appended to docs/model-changelog.md.
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { buildCases, score, tune, split, strip } from "./backtest-model.mjs";
const require = createRequire(import.meta.url);
const M = require("../site/model.js");

const MIN_GAIN = 0.0005, LEDGER_MIN = 300, MAX_STEP = 0.1, MIN_REASON = 150;
const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const APPLY = process.argv.includes("--apply");
const data = JSON.parse(readFileSync(arg("--data") || "site/data.json", "utf8"));

function loadLedger() {
  const p = arg("--ledger");
  if (p) return JSON.parse(readFileSync(p, "utf8"));
  if (existsSync(".cache/track.json")) return JSON.parse(readFileSync(".cache/track.json", "utf8"));
  try { execSync("git fetch -q origin model-ledger", { stdio: "ignore" }); return JSON.parse(execSync("git show origin/model-ledger:track.json", { maxBuffer: 1 << 28 }).toString()); }
  catch { return { picks: {} }; }
}
const ledger = loadLedger();
const graded = Object.values(ledger.picks || {}).filter(x => x.y != null);

const ll = (q, y) => -Math.log(y ? Math.max(q, 0.01) : Math.max(1 - q, 0.01));
const H = q => { q = Math.min(0.99, Math.max(0.01, q)); return -(q * Math.log(q) + (1 - q) * Math.log(1 - q)); };
const avg = (a, f) => a.length ? a.reduce((s, x) => s + f(x), 0) / a.length : null;
const r4 = x => x == null ? null : +x.toFixed(4);
const payout = b => b.price > 0 ? b.price / 100 : 100 / -b.price;

const newParams = JSON.parse(JSON.stringify(M.PARAMS));
const log = [], report = { date: new Date().toISOString().slice(0, 10), leagues: {} };

for (const [lg, sport] of Object.entries(data.sports)) {
  const out = (report.leagues[lg] = {});
  const cur = { ...M.cfg(lg) };
  // ---- 1. backtest re-tune
  const cases = buildCases(lg, sport);
  if (cases.length >= 200) {
    const { train, test } = split(cases);
    const before = score(test, lg, cur), cand = tune(lg, train, cur), after = score(test, lg, cand);
    const gain = before.logLoss - after.logLoss, mainWorse = after.mainLine.logLoss - before.mainLine.logLoss;
    const changes = Object.fromEntries(Object.entries(cand).filter(([k, v]) => k !== "marketWeight" && cur[k] !== v));
    out.backtest = { cases: test.length, current: strip(before).logLoss, candidate: strip(after).logLoss, mainCurrent: r4(before.mainLine.logLoss), mainCandidate: r4(after.mainLine.logLoss), changes };
    if (Object.keys(changes).length && gain >= MIN_GAIN && mainWorse <= 0) {
      for (const [k, v] of Object.entries(changes)) { newParams[lg] ||= {}; if (v === M.DEFAULT[k]) delete newParams[lg][k]; else newParams[lg][k] = v; }
      log.push(`${lg}: backtest log loss ${before.logLoss.toFixed(4)} → ${after.logLoss.toFixed(4)} (main line ${before.mainLine.logLoss.toFixed(4)} → ${after.mainLine.logLoss.toFixed(4)}) with ${JSON.stringify(changes)}`);
      out.backtest.applied = true;
    } else out.backtest.applied = false;
  }
  // ---- 2. live ledger: market weight
  const g = graded.filter(x => x.lg === lg);
  out.ledger = { graded: g.length };
  if (g.length) {
    let bestW = cur.marketWeight, bestLL = Infinity;
    for (let w = 0; w <= 1.0001; w += 0.05) { const v = avg(g, x => ll((1 - w) * x.model + w * x.market, x.y)); if (v < bestLL) { bestLL = v; bestW = +w.toFixed(2); } }
    Object.assign(out.ledger, { model: r4(avg(g, x => ll(x.model, x.y))), market: r4(avg(g, x => ll(x.market, x.y))), bestMarketWeight: bestW, bestBlend: r4(bestLL),
      modelBias: r4(avg(g, x => x.model - x.y)), marketBias: r4(avg(g, x => x.market - x.y)) });
    if (g.length >= LEDGER_MIN) {
      const step = Math.max(-MAX_STEP, Math.min(MAX_STEP, bestW - cur.marketWeight)), w = +Math.min(0.9, Math.max(0.3, cur.marketWeight + step)).toFixed(2);
      if (Math.abs(w - cur.marketWeight) >= 0.025) {
        newParams[lg] ||= {}; newParams[lg].marketWeight = w;
        log.push(`${lg}: market weight ${cur.marketWeight} → ${w} (best on ${g.length} graded live props: ${bestW}; ours ${out.ledger.model} vs market ${out.ledger.market})`);
      }
    }
    // ---- 3. confidence diagnostics (reviewed by hand)
    const reasons = {};
    for (const x of g) for (const c of (x.codes?.length ? x.codes : ["none"])) (reasons[c] ||= []).push(x);
    out.ledger.reasons = Object.fromEntries(Object.entries(reasons).map(([c, a]) => [c, { n: a.length, excess: r4(avg(a, x => ll(x.model, x.y) - H(x.model))), modelVsMarket: r4(avg(a, x => ll(x.model, x.y) - ll(x.market, x.y))) }]));
    out.ledger.reasonsToReview = Object.entries(out.ledger.reasons).filter(([c, r]) => r.n >= MIN_REASON).map(([c]) => c);
    const bets = g.filter(x => x.bet && x.bet.won != null && x.bet.ev > 0);
    const roi = a => a.length ? r4(avg(a, x => x.bet.won ? payout(x.bet) : -1)) : null;
    const byGrade = {}, byEv = {};
    for (const x of bets) { (byGrade[x.grade || "?"] ||= []).push(x); (byEv[x.bet.ev > 0.1 ? "10%+" : x.bet.ev > 0.05 ? "5-10%" : "0-5%"] ||= []).push(x); }
    out.ledger.bets = { n: bets.length, roi: roi(bets), expected: r4(avg(bets, x => x.bet.ev)),
      byGrade: Object.fromEntries(Object.entries(byGrade).map(([k, a]) => [k, { n: a.length, roi: roi(a), expected: r4(avg(a, x => x.bet.ev)) }])),
      byEv: Object.fromEntries(Object.entries(byEv).map(([k, a]) => [k, { n: a.length, roi: roi(a), expected: r4(avg(a, x => x.bet.ev)) }])) };
  }
}

console.log(JSON.stringify(report, null, 1));
if (!log.length) console.log("\nNo setting cleared the bar today.");
else console.log("\nChanges:\n- " + log.join("\n- "));

if (APPLY && log.length) {
  const src = readFileSync("site/model.js", "utf8");
  const start = src.indexOf("  const PARAMS = {"), end = src.indexOf("\n  };", start) + 5;
  const lit = "  const PARAMS = {\n" + Object.entries(newParams).map(([k, v]) => `    ${k}: ${JSON.stringify(v).replace(/"(\w+)":/g, "$1: ").replace(/,(?=\w)/g, ", ").replace(/^\{/, "{ ").replace(/\}$/, " }").replace("{  }", "{}")},`).join("\n") + "\n  };";
  writeFileSync("site/model.js", src.slice(0, start) + lit + src.slice(end));
  mkdirSync("docs", { recursive: true });
  if (!existsSync("docs/model-changelog.md")) writeFileSync("docs/model-changelog.md", "# Edge model changelog\n\nDaily tuning log written by `scripts/auto-tune.mjs`. Each entry lists only changes that beat the previous settings on held-out games or on graded live props.\n");
  appendFileSync("docs/model-changelog.md", `\n## ${report.date}\n\n${log.map(l => `- ${l}`).join("\n")}\n`);
  console.log("applied: site/model.js PARAMS, docs/model-changelog.md");
}
