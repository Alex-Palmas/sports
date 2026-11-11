# Edge model changelog

Daily tuning log written by `scripts/auto-tune.mjs` (run each day by a scheduled tuning session). Each entry lists only changes that beat the previous settings on held-out games or on graded live props.

## 2026-11-10

- Baseline: walk-forward backtest + per-league settings (held-out log loss NBA 0.5644, NFL 0.5782, NHL 0.4962), confidence ratings, market weight 0.65. Live ledger starts recording picks and Edge Board bets.

## 2026-11-11 (owner review: "Sabonis 10+ rebounds NO looks off")

- Cause: Sabonis (14.6 reb in 35 min this season) projected 11.1 vs the market's ~13 because last season's limited-minutes games stayed in his form at full weight, and an early-season "ORL vs forwards" matchup factor (9 ORL games, Sabonis listed as F) took 15% off.
- This season preferred: last season's games weigh 0.35 in the NBA (backtest, early-season games: log loss 0.5783 → 0.5742; all games 0.5765 → 0.5753), 0.7 in the NFL and NHL (owner preference; costs ≤0.0005 log loss there). The longer-term average uses the same weights; outcome spread uses this season's games once there are 8+.
- NBA matchup (defense vs position): shrunk by sample size (n/(n+80)) and capped at ±8% (was ±15%).
- Confidence: new penalty when the projection is far from the market's main line (the line priced nearest 50/50), up to −30.
- Edge Board: long shots beyond +300 are no longer ranked (was +400).
- Result on the current slate: Sabonis no longer an edge (best −5.3% EV); edges >2% 163 → 135; the large ones are flagged Low confidence; top High-confidence edges ~6–8%.
