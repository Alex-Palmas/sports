/* Arbitrage finder for player props.
 * A quote is { b: book, k: bookKey, l: line, o: over price, u: under price } in American odds.
 *
 * Pairing an OVER at line L1 (book A) with an UNDER at line L2 (book B):
 *   - L1 <  L2 → at least one leg always wins (both win if the result lands between: a "middle").
 *   - L1 == L2 → exactly one leg wins (whole-number results can't land on a .5 line).
 *   - L1 >  L2 → both legs can lose → never an arb, skipped.
 * With decimal odds dO, dU, staking total T as T·(1/dO)/S and T·(1/dU)/S, where S = 1/dO + 1/dU,
 * pays T/S whichever leg wins. Profit margin = 1/S − 1 (> 0 is a sure profit).
 */
(function (root) {
  const dec = a => a < 0 ? 1 + 100 / -a : 1 + a / 100;

  function findArbs(data, opts = {}) {
    const minMargin = opts.minMargin ?? 0;        // e.g. -0.02 to also show near-arbs / middles
    const out = [];
    for (const [sportKey, sport] of Object.entries(data.sports || {})) {
      const label = k => sport.stats.find(s => s.key === k)?.label || k;
      for (const p of sport.players || []) {
        for (const [k, qs] of Object.entries(p.market || {})) {
          const overs = qs.filter(q => q.o != null), unders = qs.filter(q => q.u != null);
          let best = null;
          for (const a of overs) for (const b of unders) {
            if (a === b || a.l > b.l) continue;
            if (a.b === b.b && a.l === b.l) continue;   // same book, same line: never an arb
            const dO = dec(a.o), dU = dec(b.u), S = 1 / dO + 1 / dU, margin = 1 / S - 1;
            if (margin < minMargin) continue;
            const r = { sport: sportKey, sportName: sport.name, player: p.name, team: p.team, opp: p.opp, home: p.home,
              gameDate: p.gameDate || null, gameTime: p.gameTime || null, playerId: p.id, stat: k, statLabel: label(k),
              over: a, under: b, margin, middle: a.l < b.l, wO: (1 / dO) / S, wU: (1 / dU) / S,
              hitMiddle: p.logs ? p.logs.slice(0, 20).filter(l => l.stats[k] > a.l && l.stats[k] < b.l).length / Math.max(1, Math.min(20, p.logs.length)) : 0 };
            // keep the best pair per player/prop (highest margin; middles break ties)
            if (!best || r.margin > best.margin + 1e-9 || (Math.abs(r.margin - best.margin) < 1e-9 && b.l - a.l > best.under.l - best.over.l)) best = r;
          }
          if (best) out.push(best);
        }
      }
    }
    return out.sort((x, y) => y.margin - x.margin);
  }

  const api = { findArbs, dec };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.PropArb = api;
})(typeof window !== "undefined" ? window : globalThis);
