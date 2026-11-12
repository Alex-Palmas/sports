/* PropLab model: projections, probabilities, EV, Kelly, correlation and bet settlement.
 * Pure functions on the data.json player shape; works in the browser (window.PropModel) and in Node (tests). */
(function (root) {
  const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
  const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

  // ---- odds helpers
  const impl = a => a == null ? null : a < 0 ? -a / (100 - a) : 100 / (a + 100);
  const dec = a => a < 0 ? 1 + 100 / -a : 1 + a / 100;
  const toAmerican = p => p >= 0.5 ? -Math.round(100 * p / (1 - p)) : Math.round(100 * (1 - p) / p);
  const ev = (prob, american) => prob * (dec(american) - 1) - (1 - prob);
  /** Kelly fraction of bankroll for a win probability and American price (0 if no edge). */
  const kelly = (prob, american) => { const b = dec(american) - 1; return Math.max(0, (b * prob - (1 - prob)) / b); };

  // ---- distributions
  function ncdf(x) {
    const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x / 2);
    return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
  }
  function poissonCdf(k, lam) { if (k < 0) return 0; let term = Math.exp(-lam), sum = term; for (let i = 1; i <= k; i++) { term *= lam / i; sum += term; } return Math.min(1, sum); }
  /** P(stat > line) for a projected mean/sd. Low-count stats use Poisson, the rest a normal. */
  function probOver(mu, sigma, line, dist) {
    if (!(mu >= 0)) return null;
    if (dist === "poisson") return 1 - poissonCdf(Math.floor(line), Math.max(mu, 0.01));
    const s = Math.max(sigma || 0, Math.sqrt(Math.max(mu, 1)) * 0.8, 0.5);
    return 1 - ncdf((line - mu) / s);
  }

  // ---- rest / schedule
  const days = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400e3);
  /** Each log with the rest days before it (logs newest first). */
  function withRest(logs) { return logs.map((l, i) => ({ ...l, rest: logs[i + 1] ? days(l.date, logs[i + 1].date) - 1 : null })); }
  function restSplits(logs, stat, line) {
    const r = withRest(logs).filter(l => l.rest != null && l.rest < 10);
    const grp = f => { const g = r.filter(f); return { n: g.length, avg: g.length ? mean(g.map(l => l.stats[stat] ?? 0)) : null, over: g.length ? g.filter(l => (l.stats[stat] ?? 0) > line).length / g.length : null }; };
    return { b2b: grp(l => l.rest === 0), oneDay: grp(l => l.rest === 1), rested: grp(l => l.rest >= 2) };
  }

  /** Exponentially weighted mean (newest first), half-life in games. */
  function ewMean(vals, halfLife = 8, extra) { let w = 1, sw = 0, s = 0; const k = Math.pow(0.5, 1 / halfLife); vals.forEach((v, i) => { const x = extra ? extra[i] : 1; s += v * w * x; sw += w * x; w *= k; }); return sw ? s / sw : 0; }

  const COUNT_STATS = new Set(["fg3", "stl", "blk", "td", "pass_td", "rec", "sog", "g", "ast", "hits", "tb", "rbi", "runs", "hr", "so", "reb"]);

  /**
   * Tunable settings, fitted per league by scripts/backtest-model.mjs (replaying every past game
   * with only the games before it). DEFAULT applies where a league has no fitted values.
   */
  const DEFAULT = {
    halfLife: 8, window: 30,       // recency weighting of recent form
    prevSeason: 1,                 // extra weight on last season's games (<1 favors this season)
    longShrink: 0.2,               // pull recent form toward the player's longer-term average
    minutesWeight: 1,              // how much of the minutes trend to apply
    dvpWeight: 0.6, dvpK: 40, dvpCap: 0.15, venueWeight: 0.3, restWeight: 0.5, b2b: 0.97, teammateWeight: 0.7,
    sdShrink: 0.5, cv: 0.35,       // spread: player's own sd blended with cv × mean
    sdMinCur: 8,                   // measure that sd on this season's games once there are this many
    countDisp: 1.2,                // count stats: variance = mean × countDisp (negative binomial)
    skew: 1,                       // 1: yardage/points use a right-skewed (negative binomial) curve, 0: normal
    empWeight: 0.25,               // blend with the smoothed last-20 hit rate
    calA: 1, calB: 0,              // final logistic recalibration: logit(p') = calA·logit(p) + calB
    marketWeight: 0.9,             // EV: weight on the market's vig-free price vs ours where no fitted layer exists.
                                   // On real Kalshi NBA results the price beat our projection everywhere, so the
                                   // projection only nudges it (NBA Kalshi quotes use EDGE_FIT instead).
  };
  // fitted by `node scripts/backtest-model.mjs --tune` (see site/model-report.json)
  const PARAMS = {
    nba: { restWeight: 0, cv: 0.45, prevSeason: 0.35, dvpK: 80, dvpCap: 0.08 },
    nfl: { halfLife: 3, venueWeight: 0, cv: 0.7, empWeight: 0.4, prevSeason: 0.7 },
    nhl: { halfLife: 12, longShrink: 0.35, dvpWeight: 0, sdShrink: 0.75, countDisp: 1.1, empWeight: 0.1, prevSeason: 0.7 },
    mlb: {},
  };
  const cfg = (league, over) => ({ ...DEFAULT, ...(PARAMS[league] || {}), ...(over || {}) });
  /**
   * Final edge layer for Kalshi quotes, fitted on settled Kalshi markets by scripts/market-fit.mjs:
   *   logit P(yes) = b0 + bMid·logit(market mid) + Σ coefficient·edgeFeatures()
   * Fitted out of sample (leave-one-day-out); variables that didn't improve on the market were dropped.
   */
  const EDGE_FITS = {
    // Fitted on the players the site covers (each team's rotation plus anyone with a priced prop):
    // 18,623 settled Kalshi NBA prop markets, Oct 20 – Nov 9 2026. For these players overs on points
    // and PRA ran rich; forward tests (fit on earlier days, bet NO at EV ≥ 2% on later days) returned
    // +9.7% / +8.8% / +7.3% after fees, winning 27 of 31 test days. Early-season sample: the daily
    // tuning re-checks it, and Settings → Edge model switches back to the conservative fit.
    players: { nba: { n: 18623, days: 20, through: "2026-11-09", b0: -0.1252, bMid: 0.937, statCombo: -0.4304, statPts: -0.3116 } },
    // Fitted on every Kalshi NBA prop market (bench players included): 28,431 markets, Oct 20 – Nov 10.
    // Close to the plain market price; almost nothing beats it after the spread and fee.
    market: { nba: { n: 28431, days: 21, through: "2026-11-10", b0: 0.0533, bMid: 1.0159, statCombo: -0.2115, statPts: -0.0684 } },
  };
  /** Which fit is on: Settings → Edge model ("players", the default, or "market"). */
  const edgeMode = () => { try { const v = root.localStorage?.getItem((root.PROPLAB_NS || "proplab:") + "edgeMode"); return v && EDGE_FITS[JSON.parse(v)] ? JSON.parse(v) : "players"; } catch { return "players"; } };
  const edgeFit = league => EDGE_FITS[edgeMode()][league] || null;

  // negative binomial P(X ≤ k) with mean mu and variance v (> mu); Poisson when v ≤ mu
  function countCdf(k, mu, v) {
    if (k < 0) return 0;
    if (!(v > mu * 1.0001)) return poissonCdf(k, mu);
    const r = mu * mu / (v - mu), p = r / (r + mu); // success prob
    // log space so large means (passing yards) don't underflow
    let lt = r * Math.log(p), sum = Math.exp(lt); const lq = Math.log(1 - p);
    for (let i = 1; i <= k; i++) { lt += Math.log((i - 1 + r) / i) + lq; sum += Math.exp(lt); }
    return Math.min(1, sum);
  }

  /**
   * Projection for one player/stat with an explained breakdown.
   * Factors (each a multiplier, shrunk by sample size): recent form (weighted mean, regressed
   * toward the longer-term average), minutes trend, defense vs. position, home/away, rest,
   * teammates out, blowout risk. `over` replaces settings (used by the backtest).
   */
  function project(p, stat, league, over) {
    const C = cfg(league, over);
    const all = (p.logs || []).map(l => l.stats?.[stat] ?? 0);
    const logs = (p.logs || []).slice(0, C.window);
    const vals = logs.map(l => l.stats?.[stat] ?? 0);
    if (!vals.length) return null;
    const parts = [];
    const season = logs[0]?.season, sw = logs.map(l => l.season === season ? 1 : C.prevSeason);
    // longer-term average also counts last season's games at prevSeason weight
    const allW = (p.logs || []).map(l => l.season === season ? 1 : C.prevSeason), longAvg = all.reduce((a, v, i) => a + v * allW[i], 0) / (allW.reduce((a, b) => a + b, 0) || 1);
    const ew = ewMean(vals, C.halfLife, sw);
    let mu = (1 - C.longShrink) * ew + C.longShrink * longAvg;
    const form = mu;
    parts.push({ key: "form", label: `Recent form (weighted toward the last ~${Math.round(C.halfLife)} games, regressed ${Math.round(C.longShrink * 100)}% to his ${all.length}-game average)`, value: +mu.toFixed(2) });
    // minutes trend: per-minute rate × projected minutes
    const mins = logs.map(l => l.min).filter(m => m != null && m > 0);
    if (mins.length >= 5 && C.minutesWeight) {
      const l5 = mean(mins.slice(0, 5)), l20 = mean(mins.slice(0, 20)), ewm = ewMean(mins, C.halfLife);
      const proj = 0.6 * l5 + 0.4 * l20, mult = clamp(1 + (proj / Math.max(ewm, 1) - 1) * C.minutesWeight, 0.8, 1.2);
      if (Math.abs(mult - 1) > 0.005) { mu *= mult; parts.push({ key: "minutes", label: `Minutes trend (${l5.toFixed(1)} last 5 vs ${l20.toFixed(1)} last 20)`, mult }); }
    }
    // defense vs. position
    const f = p.dvp?.factor?.[stat], n = p.dvp?.n?.[stat] || 0;
    // shrunk by the sample behind it (player-games vs this opponent's position group) and capped
    if (f && C.dvpWeight) { const mult = clamp(1 + (f - 1) * (C.dvpK === 40 ? Math.min(1, n / 40) : n / (n + C.dvpK)) * C.dvpWeight, 1 - C.dvpCap, 1 + C.dvpCap); if (Math.abs(mult - 1) > 0.002) { mu *= mult; parts.push({ key: "matchup", label: `${p.opp} vs ${p.dvp.group}s (rank ${p.dvp.rank?.[stat]}/${p.dvp.of})`, mult }); } }
    // home/away
    const home = logs.filter(l => l.home), away = logs.filter(l => !l.home);
    if (home.length >= 5 && away.length >= 5 && C.venueWeight) {
      const avgAll = mean(vals) || 1, side = mean((p.home ? home : away).map(l => l.stats?.[stat] ?? 0));
      const mult = clamp(1 + (side / avgAll - 1) * C.venueWeight, 0.92, 1.08);
      if (Math.abs(mult - 1) > 0.005) { mu *= mult; parts.push({ key: "venue", label: p.home ? "At home" : "On the road", mult }); }
    }
    // rest
    if (p.restDays === 0) {
      const r = restSplits(logs, stat, 0).b2b, avgAll = mean(vals) || 1;
      const mult = r.n >= 3 ? clamp(1 + (r.avg / avgAll - 1) * C.restWeight, 0.85, 1.1) : (league === "nba" ? C.b2b : 1);
      if (Math.abs(mult - 1) > 0.001) { mu *= mult; parts.push({ key: "rest", label: `Back-to-back${r.n >= 3 ? ` (${r.n} past B2Bs)` : ""}`, mult }); }
    }
    // Teammates out tonight. Recent form already includes the games they missed, so only the
    // share of form that came from games WITH them gets adjusted; effects combine with a cap.
    const kk = Math.pow(0.5, 1 / C.halfLife), ewWeights = logs.map((_, i) => Math.pow(kk, i)), wsum = ewWeights.reduce((a, b) => a + b, 0) || 1;
    let tm = 1;
    for (const t of p.withWithout || []) {
      const w = t.avgWith?.[stat], wo = t.avgWithout?.[stat];
      if (!(t.gamesWithout >= 3 && t.gamesWith >= 3 && w > 0.5 && wo != null)) continue;
      const missed = new Set(t.datesWithout || []);
      const shareWith = logs.reduce((a, l, i) => a + (missed.has(l.date) ? 0 : ewWeights[i]), 0) / wsum;
      const ratio = clamp(wo / w, 0.6, 1.6);
      const mult = 1 + (ratio - 1) * shareWith * Math.min(1, t.gamesWithout / 8) * C.teammateWeight;
      if (Math.abs(mult - 1) > 0.005) { tm *= mult; parts.push({ key: "teammate", label: `${t.teammate} ${String(t.status || "out").toLowerCase()} (${t.gamesWithout} games without)`, mult }); }
    }
    if (tm !== 1) { const capped = clamp(tm, 0.85, 1.25); mu *= capped; if (capped !== tm) parts.push({ key: "cap", label: "Teammate effects capped", mult: capped / tm }); }
    // blowout risk: starters sit in lopsided games
    const sp = Math.abs(p.game?.teamSpread ?? 0);
    if (league === "nba" && sp >= 10) { const mult = 0.96; mu *= mult; parts.push({ key: "blowout", label: `Blowout risk (spread ${sp})`, mult }); }
    if (league === "nfl" && sp >= 10 && /pass/.test(stat) && (p.game?.teamSpread ?? 0) < 0) { mu *= 0.96; parts.push({ key: "blowout", label: `Big favorite may run the ball late (spread ${sp})`, mult: 0.96 }); }
    // keep the projection within a sane band of recent form
    const bounded = clamp(mu, form * 0.75, form * 1.35 + 0.3);
    if (Math.abs(bounded - mu) > 1e-9) { parts.push({ key: "cap", label: "Total adjustment capped", mult: bounded / mu }); mu = bounded; }
    // spread of outcomes: the player's own (last 20) blended with a typical spread for this mean
    // spread of outcomes from this season's games when there are enough (a past role/injury distorts it)
    const curVals = logs.filter(l => l.season === season).map(l => l.stats?.[stat] ?? 0);
    const recent = curVals.length >= (C.sdMinCur ?? 99) ? curVals.slice(0, 20) : vals.slice(0, 20), psd = sd(recent);
    const sdv = recent.length >= 8 ? (1 - C.sdShrink) * psd + C.sdShrink * C.cv * Math.max(mu, 0.5) : C.cv * Math.max(mu, 0.5);
    const dist = COUNT_STATS.has(stat) && mu < 12 ? "count" : C.skew ? "skew" : "normal";
    const varCount = Math.max(mu * C.countDisp, recent.length >= 8 ? (1 - C.sdShrink) * psd * psd + C.sdShrink * mu * C.countDisp : 0);
    return { mean: +mu.toFixed(3), sd: +sdv.toFixed(3), var: +varCount.toFixed(3), dist, parts };
  }

  const logit = p => Math.log(p / (1 - p)), sigmoid = x => 1 / (1 + Math.exp(-x));
  /** Model-only P(stat > line). */
  function modelOver(proj, line) {
    if (proj.dist === "count") return 1 - countCdf(Math.floor(line), Math.max(proj.mean, 0.01), proj.var);
    if (proj.dist === "skew" && proj.mean > 0.5) return 1 - countCdf(Math.floor(line), proj.mean, Math.max(proj.sd * proj.sd, proj.mean * 1.05));
    return probOver(proj.mean, proj.sd, line, "normal");
  }
  /**
   * Probability of over/under at a line: the model's distribution, blended with the player's
   * smoothed last-20 hit rate, then passed through the fitted calibration.
   */
  function probabilities(p, stat, line, proj, league, over) {
    if (!proj) return null;
    const C = cfg(league, over);
    const pm = modelOver(proj, line);
    const lg = (p.logs || []).slice(0, 20), h = lg.filter(l => (l.stats?.[stat] ?? 0) > line).length;
    const emp = (h + 1) / (lg.length + 2);
    const raw = clamp((1 - C.empWeight) * pm + C.empWeight * emp, 0.005, 0.995);
    const over_ = clamp(sigmoid(C.calA * logit(raw) + C.calB), 0.01, 0.99);
    const push = Number.isInteger(line) ? lg.filter(l => l.stats?.[stat] === line).length / Math.max(lg.length, 1) : 0;
    return { over: over_, under: clamp(1 - over_ - push, 0.01, 0.99), model: pm, empirical: emp, raw };
  }

  /** The market's own vig-free probability for a quote's side. */
  function marketProb(q, side) {
    const io = impl(q.o), iu = impl(q.u);
    if (io != null && iu != null) return side === "over" ? io / (io + iu) : iu / (io + iu);
    const one = side === "over" ? io : iu; return one == null ? null : one / 1.045; // one-sided: remove a typical vig
  }
  /**
   * Best EV quote across books/Kalshi for a player/stat (each quote at its own line).
   * Our probability is blended with the market's vig-free price at that line (marketWeight), so the
   * model has to disagree with the market by a lot before it calls an edge, and long shots
   * (beyond +300, or favorites beyond -400) aren't ranked: that's where small-sample models are least reliable.
   */
  function bestBet(p, stat, league) {
    const C = cfg(league), proj = project(p, stat, league); if (!proj) return null;
    const line = p.lines?.[stat];
    const base = probabilities(p, stat, line, proj, league);
    let best = null;
    for (const q of p.market?.[stat] || []) for (const side of ["over", "under"]) {
      const price = side === "over" ? q.o : q.u; if (price == null || price > 300 || price < -400) continue;
      const pr = probabilities(p, stat, q.l, proj, league), mine = side === "over" ? pr.over : pr.under, mk = marketProb(q, side);
      const fitted = edgeOver(q, { p, stat, proj, league, modelOver: pr.over });
      // Kalshi quote with a fitted layer: use it. Elsewhere blend with the market (NBA: the market alone,
      // since on real Kalshi results our projection added nothing the price didn't already have).
      const w = edgeFit(league) ? 1 : C.marketWeight;
      const prob = fitted != null ? (side === "over" ? fitted : 1 - fitted) : mk == null ? mine : (1 - w) * mine + w * mk;
      const e = ev(prob, price);
      if (!best || e > best.ev) best = { side, line: q.l, price, book: q.b, prob, model: mine, market: mk, ev: e, kelly: kelly(prob, price), vol: q.vol ?? null, tk: q.tk ?? null, href: q.href ?? null, ya: q.ya ?? null, na: q.na ?? null, fitted: fitted != null };
    }
    return { proj, line, probs: base, best, confidence: confidence(p, stat, league, proj, best), fairOver: base ? toAmerican(base.over) : null, fairUnder: base ? toAmerican(base.under) : null };
  }

  /**
   * Confidence in a prop's estimate, 0–100 with a grade and the reasons points came off.
   * Penalty sizes follow the backtest's excess log loss (loss beyond what a perfectly calibrated
   * forecast would have): a changing role and an early-season sample measurably hurt; minutes
   * volatility and short histories a little; how far into the tail the line sits doesn't, so it
   * isn't penalized. What a backtest can't see gets the biggest penalties: injury tags, teammate-out
   * boosts, and on the market side (when `best` is given) no price, one-sided or thin markets,
   * long shots, and big disagreement with the market (usually news the model doesn't have).
   */
  /**
   * Confidence for picks priced by the fitted Kalshi layer (NBA): graded on what predicted results there.
   * Backtest (2,490 board picks over 20 days, each day scored by a fit without that day): EV over 25%
   * returned +31% (High), +19% (Medium); EV under 10% lost 14–22%; NO bets costing over 60¢ (YES under
   * 40¢) lost ~50%. The old projection-based penalties didn't separate winners from losers here.
   */
  function fittedConfidence(best) {
    const why = [], hit = (pts, txt, code) => { if (pts) why.push({ pts, txt, code }); };
    const yesMid = best.ya != null && best.na != null ? (best.ya + 1 - best.na) / 2 : null;
    hit(best.ev < 0.1 ? 55 : best.ev < 0.25 ? 30 : 0, best.ev < 0.1 ? "Small edge (under 10%): these lost money in testing" : "Medium edge (10–25%): about break-even in testing", "edge");
    hit(best.side === "under" && yesMid != null && yesMid < 0.4 ? 40 : 0, "Expensive NO (YES under 40¢): these lost heavily in testing", "costly");
    hit(best.vol != null && best.vol < 100 ? 10 : 0, `Thin market (${best.vol} contracts traded)`, "thin");
    const score = clamp(100 - why.reduce((a, x) => a + x.pts, 0), 0, 100);
    return { score, grade: score >= 75 ? "High" : score >= 50 ? "Medium" : "Low", why: why.sort((a, b) => b.pts - a.pts), basis: "edge" };
  }
  function confidence(p, stat, league, proj, best) {
    if (!proj) return null;
    if (best?.fitted) return fittedConfidence(best);
    const why = [], hit = (pts, txt, code) => { if (pts) why.push({ pts, txt, code }); };
    const logs = p.logs || [], season = logs[0]?.season, cur = logs.filter(l => l.season === season).length;
    hit(logs.length < 10 ? 20 : logs.length < 20 ? 5 : 0, `Only ${logs.length} games of history`, "hist");
    if (logs.length >= 10) hit(cur < 5 ? 10 : 0, `${cur} game${cur === 1 ? "" : "s"} this season`, "season");
    const mins = logs.slice(0, 10).map(l => l.min).filter(m => m > 0);
    if (mins.length >= 5) { const cv = sd(mins) / (mean(mins) || 1); hit(cv > 0.25 ? 5 : 0, `Minutes swing a lot (±${Math.round(cv * 100)}%)`, "mins"); }
    const part = k => proj.parts.filter(x => x.key === k).reduce((a, x) => a * x.mult, 1);
    hit(Math.abs(part("minutes") - 1) > 0.06 ? 10 : 0, "Role is changing (minutes trend)", "role");
    hit(Math.abs(part("teammate") - 1) > 0.1 ? 10 : 0, "Leans on teammate-out boosts (not backtested)", "teammate");
    hit(part("blowout") !== 1 ? 5 : 0, "Blowout risk", "blowout");
    const inj = String(p.injury || "");
    hit(/question|day|doubt|probable|gtd/i.test(inj) ? 20 : 0, `Player is ${inj.toLowerCase()}`, "injury");
    const tq = (p.teammatesQuestionable || []).length; hit(Math.min(10, tq * 5), `${tq} teammate${tq === 1 ? "" : "s"} questionable`, "tmq");
    // the market's own center: the line priced closest to 50/50 (books or Kalshi). A projection far from it
    // (even when the bet itself is a long-shot alt line) usually means the market knows something.
    const qs = (p.market?.[stat] || []).filter(q => q.o != null && q.u != null);
    if (qs.length) {
      const fair = q => { const io = impl(q.o), iu = impl(q.u); return io / (io + iu); };
      const mainQ = qs.slice().sort((a, b) => Math.abs(fair(a) - 0.5) - Math.abs(fair(b) - 0.5))[0];
      const me = probabilities(p, stat, mainQ.l, proj, league)?.over, mk = fair(mainQ);
      const gap = me == null ? 0 : Math.abs(me - mk);
      hit(Math.round(clamp((gap - 0.08) * 150, 0, 30)), `Projection far from the market's main line (${Math.round(me * 100)}% vs ${Math.round(mk * 100)}% over ${mainQ.l})`, "mainline");
    }
    if (best !== undefined) {
      if (!best) hit(15, "No price to compare with the market", "noprice");
      else {
        hit(best.market == null ? 5 : 0, "One-sided market", "onesided");
        hit(best.vol != null && best.vol < 100 ? 10 : 0, `Thin market (${best.vol} contracts traded)`, "thin");
        hit(best.price > 250 ? 10 : 0, "Long shot price", "longshot");
        const d = best.market == null ? 0 : Math.abs(best.model - best.market);
        hit(Math.round(clamp((d - 0.05) * 120, 0, 35)), `Model and market disagree by ${Math.round(d * 100)} points`, "disagree");
      }
    }
    const score = clamp(100 - why.reduce((a, x) => a + x.pts, 0), 0, 100);
    return { score, grade: score >= 75 ? "High" : score >= 50 ? "Medium" : "Low", why: why.sort((a, b) => b.pts - a.pts) };
  }

  // ---- game lines (moneyline / spread / total)
  // Spread of outcomes per league: margin and total standard deviations (NHL goals use Poisson);
  // hfa = home edge in points/goals; k = games of shrinkage toward league average.
  const GAME = { nba: { hfa: 2.5, sdM: 12.5, sdT: 18, k: 6, half: 8 }, nfl: { hfa: 1.5, sdM: 13.5, sdT: 13.5, k: 4, half: 6 },
    nhl: { hfa: 0.15, poisson: true, k: 8, half: 10 }, mlb: { hfa: 0.15, poisson: true, k: 10, half: 12 } };
  const GAME_MARKET_WEIGHT = 0.85;   // game lines are sharp: the market dominates
  /**
   * Projected score for a game from each side's recent points for/against (recency-weighted, shrunk to
   * the league average): home = off(home) + def(away) − league avg + home edge.
   */
  /**
   * A team's games from this season (newest first). Last season's are used only when this season has
   * fewer than 5; entries are flagged season "cur"/"prev", or (older data) split at a 60-day gap.
   */
  function seasonForm(f) {
    f = f || []; if (!f.length) return f;
    let cur = f.filter(x => x.season ? x.season === "cur" : true);
    if (!f.some(x => x.season)) { const newest = Date.parse(f[0].date); cur = []; for (let i = 0; i < f.length; i++) { if (i && Date.parse(f[i - 1].date) - Date.parse(f[i].date) > 60 * 86400e3) break; cur.push(f[i]); } }
    return cur.length >= 5 ? cur : f;
  }
  function gameModel(g, league, lgAvg) {
    const C = GAME[league] || GAME.nba;
    const fH = seasonForm(g.form?.[g.home]).slice(0, 15), fA = seasonForm(g.form?.[g.away]).slice(0, 15);
    if (fH.length < 3 || fA.length < 3) return null;
    const lg = lgAvg || mean([...fH, ...fA].flatMap(x => [x.pf, x.pa]));
    const rate = (f, key) => lg + (ewMean(f.map(x => x[key]), C.half) - lg) * f.length / (f.length + C.k);
    const home = rate(fH, "pf") + rate(fA, "pa") - lg + C.hfa / 2, away = rate(fA, "pf") + rate(fH, "pa") - lg - C.hfa / 2;
    const total = home + away, margin = home - away, sdM = C.poisson ? Math.sqrt(Math.max(total, 1)) : C.sdM;
    /** P(team wins by more than l); l can be negative (e.g. +3.5 underdog covers = wins by more than −3.5). */
    const pBy = (team, l) => { const m = team === g.home ? margin : -margin; return 1 - ncdf((l - m) / sdM); };
    const pOver = L => C.poisson ? 1 - poissonCdf(Math.floor(L), Math.max(total, 0.1)) : 1 - ncdf((L - total) / C.sdT);
    return { home, away, total, margin, pWin: team => pBy(team, 0), pBy, pOver };
  }
  /** Every game-line price (DraftKings + Kalshi) with our blended probability and EV, best first. */
  function gameBets(g, league, lgAvg) {
    const m = gameModel(g, league, lgAvg), out = [];
    const add = (o) => { if (o.price == null || o.price > 400 || o.price < -400) return;
      const prob = o.market == null ? o.model : o.model == null ? o.market : (1 - GAME_MARKET_WEIGHT) * o.model + GAME_MARKET_WEIGHT * o.market;
      if (prob == null) return; out.push({ ...o, prob, ev: ev(prob, o.price) }); };
    const pair = (a, b) => { const ia = impl(a), ib = impl(b); return ia != null && ib != null ? [ia / (ia + ib), ib / (ia + ib)] : [null, null]; };
    const sgn = x => (x > 0 ? "+" : "") + x;
    const dk = g.dk || {}, book = dk.book || "DraftKings", other = t => t === g.home ? g.away : g.home;
    if (dk.ml?.home != null && dk.ml?.away != null) { const [ph, pa] = pair(dk.ml.home, dk.ml.away);
      add({ kind: "ml", label: `${g.home} ML`, price: dk.ml.home, book, model: m?.pWin(g.home), market: ph });
      add({ kind: "ml", label: `${g.away} ML`, price: dk.ml.away, book, model: m?.pWin(g.away), market: pa }); }
    const sp = dk.spread;
    if (sp?.home != null && sp.homeOdds != null && sp.awayOdds != null) { const [ph, pa] = pair(sp.homeOdds, sp.awayOdds);
      add({ kind: "spread", label: `${g.home} ${sgn(sp.home)}`, price: sp.homeOdds, book, model: m?.pBy(g.home, -sp.home), market: ph });
      add({ kind: "spread", label: `${g.away} ${sgn(-sp.home)}`, price: sp.awayOdds, book, model: m?.pBy(g.away, sp.home), market: pa }); }
    const tt = dk.total;
    if (tt?.line != null && tt.over != null && tt.under != null) { const [po, pu] = pair(tt.over, tt.under);
      add({ kind: "total", label: `Over ${tt.line}`, price: tt.over, book, model: m ? m.pOver(tt.line) : null, market: po });
      add({ kind: "total", label: `Under ${tt.line}`, price: tt.under, book, model: m ? 1 - m.pOver(tt.line) : null, market: pu }); }
    const K = g.kalshi || {};
    for (const [team, q] of Object.entries(K.ml || {})) { const [py] = pair(q.o, q.u);
      add({ kind: "ml", label: `${team} ML`, price: q.o, book: "Kalshi", model: m?.pWin(team), market: py, href: q.href, vol: q.vol, leg: { action: "YES", contract: q.title ? (/win/i.test(q.title) ? q.title : `${q.title} wins`) : `${team} wins`, cents: Math.round(q.ya * 100) } }); }
    for (const q of K.spread || []) { const [py, pn] = pair(q.o, q.u);
      const c = q.title || `${q.team} wins by over ${q.l}`;
      add({ kind: "spread", label: `${q.team} -${q.l}`, price: q.o, book: "Kalshi", model: m?.pBy(q.team, q.l), market: py, href: q.href, vol: q.vol, leg: { action: "YES", contract: c, cents: Math.round(q.ya * 100) } });
      add({ kind: "spread", label: `${other(q.team)} +${q.l}`, price: q.u, book: "Kalshi", model: m ? 1 - m.pBy(q.team, q.l) : null, market: pn, href: q.href, vol: q.vol, leg: { action: "NO", contract: c, cents: Math.round(q.na * 100) } }); }
    for (const q of K.total || []) { const [py, pn] = pair(q.o, q.u);
      const c = q.title || `Over ${q.l} total`;
      add({ kind: "total", label: `Over ${q.l}`, price: q.o, book: "Kalshi", model: m ? m.pOver(q.l) : null, market: py, href: q.href, vol: q.vol, leg: { action: "YES", contract: c, cents: Math.round(q.ya * 100) } });
      add({ kind: "total", label: `Under ${q.l}`, price: q.u, book: "Kalshi", model: m ? 1 - m.pOver(q.l) : null, market: pn, href: q.href, vol: q.vol, leg: { action: "NO", contract: c, cents: Math.round(q.na * 100) } }); }
    return { model: m, bets: out.sort((a, b) => b.ev - a.ev) };
  }

  /**
   * Which Kalshi contract to buy for a prop pick. Kalshi lists each strike as a yes/no market
   * "Player: N+ stat": Over (N−0.5) = buy YES, Under (N−0.5) = buy NO. Price in cents (the ask, before fees).
   */
  function kalshiLeg(side, line, label, best) {
    const n = Math.floor(line) + 1, action = side === "over" ? "YES" : "NO";
    const ask = side === "over" ? best?.ya : best?.na;
    const cents = ask != null ? Math.round(ask * 100) : best?.price != null ? Math.round(impl(best.price) * 100) : null;
    return { action, contract: `${n}+ ${label}`, cents };
  }

  /** How often two props hit together across games both players played (phi coefficient). */
  function correlation(logsA, statA, lineA, logsB, statB, lineB) {
    const b = Object.fromEntries((logsB || []).map(l => [l.date, l.stats?.[statB]]));
    const pairs = (logsA || []).filter(l => b[l.date] != null).map(l => [(l.stats?.[statA] ?? 0) > lineA ? 1 : 0, b[l.date] > lineB ? 1 : 0]);
    const n = pairs.length; if (n < 6) return null;
    const pa = mean(pairs.map(x => x[0])), pb = mean(pairs.map(x => x[1])), both = mean(pairs.map(x => x[0] * x[1]));
    const den = Math.sqrt(pa * (1 - pa) * pb * (1 - pb));
    return { n, both, independent: pa * pb, phi: den ? (both - pa * pb) / den : 0, pa, pb };
  }

  /** Settle a tracked bet from the player's game log. */
  function settle(bet, logs) {
    const day = (bet.gameDate || "").slice(0, 10);
    const l = (logs || []).find(x => x.date === day); if (!l) return null;
    const v = l.stats?.[bet.stat]; if (v == null) return null;
    const result = v === bet.line ? "push" : (bet.side === "over" ? v > bet.line : v < bet.line) ? "won" : "lost";
    const pnl = result === "push" ? 0 : result === "won" ? bet.stake * (dec(bet.price) - 1) : -bet.stake;
    return { actual: v, result, pnl: +pnl.toFixed(2) };
  }
  /** Closing-line value: positive when you beat the final price (in probability points) and/or line. */
  function clv(bet) {
    if (!bet.close) return null;
    const pp = impl(bet.close.price) != null && impl(bet.price) != null ? impl(bet.close.price) - impl(bet.price) : null;
    const dl = bet.close.line != null ? (bet.side === "over" ? bet.close.line - bet.line : bet.line - bet.close.line) : null;
    return { prob: pp, line: dl };
  }

  /** Kalshi quote → { mid, bid, ask, mid0 } (mid0: the first price seen today at the same strike). */
  function kalshiMid(q) {
    if (q?.ya == null || q?.na == null) return null;
    const bid = 1 - q.na, mid = (q.ya + bid) / 2;
    let mid0 = null;
    if (q.ol === q.l && q.oo != null && q.ou != null && (q.oo !== q.o || q.ou !== q.u)) { const yo = impl(q.oo), no = impl(q.ou); if (yo && no) mid0 = clamp((yo + 1 - no) / 2, 0.01, 0.99); }
    return { mid, bid, ask: q.ya, mid0 };
  }
  /** Fitted P(over) at a Kalshi quote's strike, or null (no fit for this league, not a Kalshi quote). */
  function edgeOver(q, { p, stat, proj, league, modelOver: mo }) {
    const fit = edgeFit(league), k = q?.b === "Kalshi" ? kalshiMid(q) : null;
    if (!fit || !k || !(k.mid > 0.02 && k.mid < 0.98)) return null;
    const f = edgeFeatures({ ...k, model: mo, stat, line: q.l, proj, p });
    let x = fit.b0 + fit.bMid * logit(clamp(k.mid, 0.01, 0.99));
    for (const [name, c] of Object.entries(fit)) if (name in f) x += c * f[name];
    return clamp(sigmoid(x), 0.01, 0.99);
  }
  /**
   * Variables for the final edge layer (fitted on settled Kalshi markets by scripts/market-fit.mjs).
   * Everything here is known before tip-off: the quote, our model, the player's recent minutes,
   * venue, rest, matchup and the stat family.
   */
  function edgeFeatures({ mid, bid, ask, mid0, model, stat, line, proj, p }) {
    const lgt = x => logit(clamp(x, 0.01, 0.99));
    const mins = (p?.logs || []).slice(0, 20).map(l => l.min).filter(m => m > 0);
    const l5 = mean(mins.slice(0, 5)), l20 = mean(mins);
    const dvpPart = (proj?.parts || []).filter(x => x.key === "matchup").reduce((a, x) => a * x.mult, 1);
    const z = proj && proj.sd > 0 ? (line - proj.mean) / Math.max(proj.sd, 1) : 0;
    return {
      model: model == null ? 0 : lgt(model) - lgt(mid),
      spread: ask != null && bid != null ? (ask - bid) * 10 : 0,
      move: mid0 != null ? clamp(lgt(mid) - lgt(mid0), -2, 2) : 0,   // how far the price moved before tip (sharp money)
      minTrend: mins.length >= 5 && l20 ? clamp(l5 / l20 - 1, -0.5, 0.5) * 5 : 0,
      home: p?.home ? 1 : -1,
      b2b: p?.restDays === 0 ? 1 : 0,
      dvp: (dvpPart - 1) * 10,
      statPts: stat === "pts" ? 1 : 0, statReb: stat === "reb" ? 1 : 0, statAst: stat === "ast" ? 1 : 0, stat3: stat === "fg3" ? 1 : 0,
      statCombo: /^(pra|pr|pa|ra)$/.test(stat) ? 1 : 0, statDef: /^(stl|blk)$/.test(stat) ? 1 : 0,
      farOver: clamp(z, 0, 3), farUnder: clamp(-z, 0, 3),
    };
  }
  const api = { fittedConfidence, get EDGE_FIT() { return EDGE_FITS[edgeMode()]; }, EDGE_FITS, edgeMode, edgeFit, edgeOver, kalshiMid, edgeFeatures, kalshiLeg, seasonForm, gameModel, gameBets, GAME, confidence, PARAMS, DEFAULT, cfg, countCdf, modelOver, logit, sigmoid, marketProb, mean, sd, impl, dec, toAmerican, ev, kelly, ncdf, poissonCdf, probOver, withRest, restSplits, ewMean, project, probabilities, bestBet, correlation, settle, clv };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.PropModel = api;
})(typeof window !== "undefined" ? window : globalThis);
