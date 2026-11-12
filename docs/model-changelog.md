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

## 2026-11-12 (owner: "does it account for the opponent's defense and matchups?")

- Tested on 18,523 settled Kalshi NBA prop markets for the site's players (Oct 20 – Nov 9, 20 days), each matched to its game. Each variable was added to the fitted Kalshi layer and validated leave-one-day-out:
  - **Team stats** (from ESPN results before that date, point-in-time): the opponent's points allowed, and pace (the two teams' average total points).
  - **Market expectations** (`scripts/game-context.mjs`): Kalshi's pre-game game total and spread, interpolated to 50% from the ladders in the last hour before tip, giving each team's implied points and blowout size.
  - **Versions:** each variable was tried on its own and also limited to points-type props, rebounds or assists.
- **Result:** none improved on the price. Every one made out-of-sample log loss slightly worse (+0.00001 to +0.00025), so nothing was added. The prop prices already include the opponent's defense, pace, and the game total and spread.
- **Not tested:** individual defender matchups (who guards whom). NBA.com's matchup tracking can't be reached from these servers.

## 2026-11-12 (owner: "sure, let's try it")

- **Default changed:** NBA Kalshi props now use the fit on the site's own players (`EDGE_FITS.players`: 18,623 markets, Oct 20 – Nov 9). Its terms are b0 −0.125, bMid 0.937, PRA/combos −0.430 and points −0.312.
  - **Why:** for these players, overs on points and PRA ran well above their hit rates in both halves of the season. For example, PRA priced at 55–75% hit 47% (first half) and 50% (second half) against an average price of 64%; points priced at 35–55% hit 37% and 35% against 45%. Rebounds stayed close to fair.
  - **Forward tests** (fit on earlier days, bet NO at EV ≥ 2% on later days): +9.7%, +8.8% and +7.3% after fees, with 12/14, 9/10 and 6/7 winning days.
- **Switching back:** Settings → Edge model → **Conservative** returns to the all-markets fit (`EDGE_FITS.market`), which follows Kalshi's price.
- **On the current slate:** 291 NBA props with EV ≥ 2%, all NO (points 117, PRA 99, 3-pointers 29, rebounds 23, assists 21).
- **Caveat:** this is early-season data. The daily tuning re-checks the bias on new results and should set the default back to Conservative if it stops holding in a forward test.

## 2026-11-12 (owner: "are game lines profitable? look into college basketball and football")

- **New tools:**
  - `scripts/college-lines.mjs` collects settled Kalshi total and spread ladders, with each strike's YES bid/ask in the hour before the start, and matches each game to ESPN's final score. It covers ncaaf, ncaamb, nba, nfl and nhl.
  - `scripts/lines-backtest.mjs` tests simple rules at the real prices after Kalshi's fee, separately for the earlier and later half of the dates.
- **Results.** A rule needed to win in both halves to count; none did except as noted.

  | League | Games | Days | Overs at the main total line | Rules |
  |---|---|---|---|---|
  | College football | 1,013 | 43 | 50.2% (priced 50.1%) | Every rule lost after fees in at least one half: unders/overs, favorites/underdogs, big favorites/underdogs (10+), long-shot ladder strikes. Best: underdogs at −0.4% / −4.3%. |
  | College basketball | 448 | 10 | 48.1% (priced 50.2%) | Every rule lost in at least one half. Best: unders at +2.5% / −5.2%. |
  | NBA | 160 | 22 | 45.6% | Unders won in both halves (+3.1% / +4.9%), and NO on long-shot overs (+1.2% / +2.0%), but on only 76–84 games per half. Not proven; to be re-checked as games accumulate. |
- **Kalshi has no college player props;** college markets are game lines, halves/quarters and team stats.
- **Nothing added** to the Edge Board for game lines.

## 2026-11-12 (owner: "look into tennis too, do all the backtesting")

- **Data:** `scripts/tennis-lines.mjs` collected 10,909 settled Kalshi tennis events (Oct 1 – Nov 12):
  - match winners: ATP, WTA, ATP/WTA Challenger, ITF men/women;
  - ATP/WTA total games.
- **Method:**
  - Kalshi's tennis start times are placeholders, so the pre-match price is the hourly candle ending 4 hours before the market closed (the match end).
  - Results come from Kalshi's settlement.
  - Rules are priced at the real ask, after the fee, and split at Oct 22.
- **Results.** A rule had to win in both halves to count; only the ATP underdog rule did.

  | Market | Matches | Result |
  |---|---|---|
  | ATP | 463 | Favorites won less often than priced at every level (e.g. 48% at 50–60¢, 87% at 90–100¢). Underdogs +3.3% / +5.1%; slight underdogs (40–50¢) +6.6% / +16.9%. About 1 standard error, so not proven. Watch only. |
  | WTA | 423 | Mixed; no rule positive in both halves. |
  | ATP Challenger | 1,572 | Close to fair. Favorites −6.4% / −6.3%, underdogs −1.7% / −1.8%. |
  | WTA Challenger | 427 | No rule positive in both halves. |
  | ITF men | 3,446 | Well calibrated. Long shots overpriced (underdogs −12% / −17%). Favorites close but still negative after fees (−3.9% / −1.7%). |
  | ITF women | 3,846 | Same as ITF men. Favorites −3.4% / −2.7%, heavy favorites −2.3% / −1.1%, underdogs −14%. |
  | ATP total games | 396 | Unders −15.6% / −6.4%, overs +5.4% / −4.0%. Nothing. |
  | WTA total games | 336 | Unders −6.3% / −8.7%, overs −4.1% / −1.8%. Nothing. |
- **Conclusion:** no tennis rule that's proven profitable. The ATP-underdog lean should be re-checked as matches accumulate. Nothing added to the site.
