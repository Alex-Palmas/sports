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

## 2026-11-11 (owner review: "tested ~30 bets, most are wrong")

- New: the model is now scored against the real Kalshi market instead of only against box scores.
  - `scripts/kalshi-history.mjs` collects every settled Kalshi NBA prop market: each strike's result, plus the YES bid/ask in the last hour before tip and ~6 hours before.
  - `scripts/market-backtest.mjs` rebuilds each player as of that morning and prices the strike, so the model and the market are scored side by side.
  - `scripts/market-fit.mjs` fits a final logistic layer, `logit P = b0 + bMid·logit(mid) + Σ bk·variable`, with leave-one-day-out validation. A variable is kept only if it lowers out-of-sample log loss.
- Data: 28,431 markets with a pre-game quote, Oct 20 – Nov 10, 2026. 18,623 of them belong to players on the site; those are used to test player variables.
- Findings:
  - **Log loss:** market mid 0.5010, our raw model 0.5191 (worse than the price). Blends got worse the more weight the model had; weight 1 on the market was best.
  - **Variables tested** (none improved on the price out of sample): our projection, line movement before tip, bid/ask spread, minutes trend, home/away, back-to-back, defense vs position, stat type, and the line's distance from our projection.
  - **The projection's coefficient was negative.** When the model liked an over more than the market did, that over hit even less often.
  - **Market calibration:** good. The lasting bias is that PRA overs run ~2–3 points rich and points overs ~1 point rich.
  - **Always-NO / always-YES rules by stat:** all lost money after the spread and fee in both halves of the sample (PRA NO, the best, lost 1–3%).
  - **Old Edge Board rule:** on the first day replayed, it lost 16–29% after fees.
- Changes:
  - NBA Kalshi quotes are priced by the fitted layer (`EDGE_FIT`): the market mid, recalibrated, with the PRA/points markdown.
  - NBA sportsbook quotes now use the market alone.
  - Other leagues: the market weight went from 0.65 to 0.9.
  - The Bet button re-prices the estimate at the live quote before ordering.
  - Bets tab: the record now shows how many wins your prices implied.
- Result on the current slate: 0 props with positive EV (previously 135 above 2%). The Edge Board says so plainly instead of listing model errors as edges.
