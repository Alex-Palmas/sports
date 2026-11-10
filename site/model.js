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
  function ewMean(vals, halfLife = 8) { let w = 1, sw = 0, s = 0; const k = Math.pow(0.5, 1 / halfLife); for (const v of vals) { s += v * w; sw += w; w *= k; } return sw ? s / sw : 0; }

  const COUNT_STATS = new Set(["fg3", "stl", "blk", "td", "pass_td", "rec", "sog", "g", "ast", "pts_nhl", "hits", "tb", "rbi", "runs", "hr", "so"]);

  /**
   * Projection for one player/stat with an explained breakdown.
   * Factors (each a multiplier, shrunk by sample size): recent form (weighted mean), minutes
   * trend, defense vs. position, home/away, rest, teammates out, blowout risk.
   */
  function project(p, stat, league) {
    const logs = (p.logs || []).slice(0, 30);
    const vals = logs.map(l => l.stats?.[stat] ?? 0);
    if (!vals.length) return null;
    const parts = [];
    let mu = ewMean(vals);
    const form = mu;
    parts.push({ key: "form", label: "Recent form (weighted toward the last ~8 games)", value: +mu.toFixed(2) });
    // minutes trend: per-minute rate × projected minutes
    const mins = logs.map(l => l.min).filter(m => m != null && m > 0);
    if (mins.length >= 5) {
      const l5 = mean(mins.slice(0, 5)), l20 = mean(mins.slice(0, 20)), ewm = ewMean(mins);
      const proj = 0.6 * l5 + 0.4 * l20, mult = clamp(proj / Math.max(ewm, 1), 0.8, 1.2);
      if (Math.abs(mult - 1) > 0.005) { mu *= mult; parts.push({ key: "minutes", label: `Minutes trend (${l5.toFixed(1)} last 5 vs ${l20.toFixed(1)} last 20)`, mult }); }
    }
    // defense vs. position
    const f = p.dvp?.factor?.[stat], n = p.dvp?.n?.[stat] || 0;
    if (f) { const mult = clamp(1 + (f - 1) * Math.min(1, n / 40) * 0.6, 0.85, 1.15); mu *= mult; parts.push({ key: "matchup", label: `${p.opp} vs ${p.dvp.group}s (rank ${p.dvp.rank?.[stat]}/${p.dvp.of})`, mult }); }
    // home/away
    const home = logs.filter(l => l.home), away = logs.filter(l => !l.home);
    if (home.length >= 5 && away.length >= 5) {
      const all = mean(vals) || 1, side = mean((p.home ? home : away).map(l => l.stats?.[stat] ?? 0));
      const mult = clamp(1 + (side / all - 1) * 0.3, 0.92, 1.08);
      if (Math.abs(mult - 1) > 0.005) { mu *= mult; parts.push({ key: "venue", label: p.home ? "At home" : "On the road", mult }); }
    }
    // rest
    if (p.restDays === 0) {
      const r = restSplits(logs, stat, 0).b2b, all = mean(vals) || 1;
      const mult = r.n >= 3 ? clamp(1 + (r.avg / all - 1) * 0.5, 0.85, 1.1) : (league === "nba" ? 0.97 : 1);
      if (mult !== 1) { mu *= mult; parts.push({ key: "rest", label: `Back-to-back${r.n >= 3 ? ` (${r.n} past B2Bs)` : ""}`, mult }); }
    }
    // Teammates out tonight. Recent form already includes the games they missed, so only the
    // share of form that came from games WITH them gets adjusted; effects combine with a cap.
    const ewWeights = logs.map((_, i) => Math.pow(Math.pow(0.5, 1 / 8), i)), wsum = ewWeights.reduce((a, b) => a + b, 0) || 1;
    let tm = 1;
    for (const t of p.withWithout || []) {
      const w = t.avgWith?.[stat], wo = t.avgWithout?.[stat];
      if (!(t.gamesWithout >= 3 && t.gamesWith >= 3 && w > 0.5 && wo != null)) continue;
      const missed = new Set(t.datesWithout || []);
      const shareWith = logs.reduce((a, l, i) => a + (missed.has(l.date) ? 0 : ewWeights[i]), 0) / wsum;
      const ratio = clamp(wo / w, 0.6, 1.6);
      const mult = 1 + (ratio - 1) * shareWith * Math.min(1, t.gamesWithout / 8) * 0.7;
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
    const recent = vals.slice(0, 20);
    const dist = mu < 6 && (COUNT_STATS.has(stat) || mu < 3) ? "poisson" : "normal";
    return { mean: +mu.toFixed(2), sd: +sd(recent).toFixed(2), dist, parts };
  }

  /**
   * Probability of over/under at a line: 75% model, 25% the player's smoothed last-20 hit rate,
   * so a projection can't drift far from what actually happened.
   */
  function probabilities(p, stat, line, proj) {
    if (!proj) return null;
    const pm = probOver(proj.mean, proj.sd, line, proj.dist);
    const lg = (p.logs || []).slice(0, 20), h = lg.filter(l => (l.stats?.[stat] ?? 0) > line).length;
    const emp = (h + 1) / (lg.length + 2);
    const over = clamp(0.75 * pm + 0.25 * emp, 0.01, 0.99);
    const push = Number.isInteger(line) ? lg.filter(l => l.stats?.[stat] === line).length / Math.max(lg.length, 1) : 0;
    return { over, under: clamp(1 - over - push, 0.01, 0.99), model: pm, empirical: emp };
  }

  /** The market's own vig-free probability for a quote's side. */
  function marketProb(q, side) {
    const io = impl(q.o), iu = impl(q.u);
    if (io != null && iu != null) return side === "over" ? io / (io + iu) : iu / (io + iu);
    const one = side === "over" ? io : iu; return one == null ? null : one / 1.045; // one-sided: remove a typical vig
  }
  /**
   * Best EV quote across books/Kalshi for a player/stat (each quote at its own line).
   * Our probability is blended 50/50 with the market's vig-free price at that line, so the
   * model has to disagree with the market by a lot before it calls an edge, and long shots
   * (beyond ±400) aren't ranked: that's where small-sample models are least reliable.
   */
  function bestBet(p, stat, league) {
    const proj = project(p, stat, league); if (!proj) return null;
    const line = p.lines?.[stat];
    const base = probabilities(p, stat, line, proj);
    let best = null;
    for (const q of p.market?.[stat] || []) for (const side of ["over", "under"]) {
      const price = side === "over" ? q.o : q.u; if (price == null || price > 400 || price < -400) continue;
      const pr = probabilities(p, stat, q.l, proj), mine = side === "over" ? pr.over : pr.under, mk = marketProb(q, side);
      const prob = mk == null ? mine : 0.5 * mine + 0.5 * mk;
      const e = ev(prob, price);
      if (!best || e > best.ev) best = { side, line: q.l, price, book: q.b, prob, model: mine, market: mk, ev: e, kelly: kelly(prob, price) };
    }
    return { proj, line, probs: base, best, fairOver: base ? toAmerican(base.over) : null, fairUnder: base ? toAmerican(base.under) : null };
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

  const api = { marketProb, mean, sd, impl, dec, toAmerican, ev, kelly, ncdf, poissonCdf, probOver, withRest, restSplits, ewMean, project, probabilities, bestBet, correlation, settle, clv };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.PropModel = api;
})(typeof window !== "undefined" ? window : globalThis);
