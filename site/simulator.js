/* Paper-trading simulator for the Kalshi Latency Study.
 * Replays recorded order-book tops around each play (saved by scripts/kalshi-latency.mjs)
 * and asks: if you had acted when your feed delivered the play, what would you have made?
 *
 * Strategies
 *   settled  – a play settles a player prop (e.g. takes him past 20 pts): buy YES at the ask
 *              and hold to the $1 payout.
 *   rung     – any stat change by a player with Kalshi lines (a basket from 15 to 17 pts): buy
 *              YES on his next line(s) up at the ask, sell at the bid after `hold` seconds.
 *   gameline – a score: buy the scoring team's moneyline YES at the ask, sell at the bid
 *              after `hold` seconds.
 *
 * Timing: you act at (feed delay + order delay) seconds after the play. The feed delay is the
 * recorded one, or a hypothetical faster feed. Fills are at the recorded best ask/bid at that
 * moment, capped by the size shown when it was recorded. It ignores queue position, your own
 * market impact and stat corrections, so treat it as an upper bound.
 * Kalshi taker fee per order: ceil(0.07 × contracts × p × (1 − p)) to the cent.
 */
(function (root) {
  const fee = (p, qty) => Math.ceil(0.07 * qty * p * (1 - p) * 100 - 1e-9) / 100;
  /** Book state at t seconds after the play: [dt, bid, ask, askSize]. */
  function at(book, t) { let s = null; for (const p of book || []) { if (p[0] <= t) s = p; else break; } return s; }

  function simulate(recordings, o = {}) {
    const P = { strategies: ["settled", "rung", "gameline"], orderDelay: 0.5, feedDelay: null, maxPrice: 0.9, minEdge: 0.02, contracts: 10,
      hold: 30, rungs: 1, league: "all", clutchOnly: false, minPoints: 1, ...o };
    const trades = [], skipped = { noPrice: 0, tooExpensive: 0, noBook: 0, alreadyMoved: 0 };
    const enterAt = rec => (P.feedDelay != null ? P.feedDelay : rec.feedDelay ?? 0) + P.orderDelay;
    const okLeague = l => P.league === "all" || (l || "nba") === P.league;

    const buy = (book, t) => { const s = at(book, t); if (!s) return null; const ask = s[2]; if (ask == null || ask <= 0 || ask >= 0.995) return null; return { ask, size: s[3] }; };
    const sellBid = (book, t) => { const s = at(book, t); return s && s[1] != null ? s[1] : null; };
    const qtyFor = size => Math.max(1, Math.min(P.contracts, size || P.contracts));

    for (const rec of recordings) {
      if (!rec) continue;
      const session = rec.started;
      if (P.strategies.includes("settled")) for (const c of rec.crossings || []) {
        if (c.alreadyPriced || !okLeague(c.league)) continue;
        if (!c.book) { skipped.noBook++; continue; }
        const t = enterAt(c), b = buy(c.book, t);
        if (!b) { skipped.noPrice++; continue; }
        if (b.ask > P.maxPrice || 1 - b.ask - fee(b.ask, 1) < P.minEdge) { skipped.tooExpensive++; continue; }
        const qty = qtyFor(b.size), cost = b.ask * qty + fee(b.ask, qty);
        trades.push({ session, strategy: "settled", time: c.play, game: c.game, label: `${c.player} ${Math.ceil(c.line)}+ ${c.stat}`, entryT: t, entry: b.ask, exit: 1, qty, pnl: +(qty - cost).toFixed(2) });
      }
      if (P.strategies.includes("rung")) for (const e of rec.playerEvents || []) {
        if (!okLeague(e.league)) continue;
        for (const r of (e.rungs || []).slice(0, P.rungs)) {
          if (!r.book) { skipped.noBook++; continue; }
          const t = enterAt(e), b = buy(r.book, t);
          if (!b) { skipped.noPrice++; continue; }
          if (b.ask > P.maxPrice) { skipped.tooExpensive++; continue; }
          const bid = sellBid(r.book, t + P.hold); if (bid == null) { skipped.noPrice++; continue; }
          const qty = qtyFor(b.size), pnl = qty * (bid - b.ask) - fee(b.ask, qty) - fee(bid, qty);
          trades.push({ session, strategy: "rung", time: e.play, game: e.game, label: `${e.player} ${Math.ceil(r.line)}+ ${e.stat} after ${e.before}→${e.after}`, entryT: t, entry: b.ask, exit: bid, qty, pnl: +pnl.toFixed(2) });
        }
      }
      if (P.strategies.includes("gameline")) for (const s of rec.scoreReactions || []) {
        if (!okLeague(s.league) || (P.clutchOnly && !s.clutch) || (s.points || 0) < P.minPoints) continue;
        if (!s.book) { skipped.noBook++; continue; }
        const t = enterAt(s), b = buy(s.book, t);
        if (!b) { skipped.noPrice++; continue; }
        if (b.ask > P.maxPrice) { skipped.tooExpensive++; continue; }
        const bid = sellBid(s.book, t + P.hold); if (bid == null) { skipped.noPrice++; continue; }
        const qty = qtyFor(b.size), pnl = qty * (bid - b.ask) - fee(b.ask, qty) - fee(bid, qty);
        trades.push({ session, strategy: "gameline", time: s.play, game: s.game, label: `${s.team} +${s.points}${s.clutch ? " (clutch)" : ""}`, entryT: t, entry: b.ask, exit: bid, qty, pnl: +pnl.toFixed(2) });
      }
    }
    trades.sort((a, b) => a.time.localeCompare(b.time));
    let cum = 0; for (const t of trades) t.cum = +(cum += t.pnl).toFixed(2);
    const by = k => { const m = {}; for (const t of trades) { const x = (m[t[k]] ||= { key: t[k], trades: 0, wins: 0, pnl: 0, staked: 0 }); x.trades++; x.wins += t.pnl > 0; x.pnl += t.pnl; x.staked += t.entry * t.qty; } return Object.values(m).map(x => ({ ...x, pnl: +x.pnl.toFixed(2), staked: +x.staked.toFixed(2) })).sort((a, b) => b.pnl - a.pnl); };
    const staked = trades.reduce((a, t) => a + t.entry * t.qty, 0);
    return {
      params: P, trades, skipped,
      summary: { trades: trades.length, wins: trades.filter(t => t.pnl > 0).length, pnl: +cum.toFixed(2), staked: +staked.toFixed(2),
        roi: staked ? cum / staked : null, avg: trades.length ? cum / trades.length : null,
        worst: trades.length ? Math.min(...trades.map(t => t.pnl)) : null, best: trades.length ? Math.max(...trades.map(t => t.pnl)) : null },
      byStrategy: by("strategy"), byGame: by("game"),
    };
  }

  const api = { simulate, fee, at };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.PropSim = api;
})(typeof window !== "undefined" ? window : globalThis);
