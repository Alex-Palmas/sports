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

## 2026-11-12 (owner: "compare big-disagreement picks and confidence levels; do the suggested things")

- **Backtest of the board's own rule.** One pick per prop, the best EV at the board's price limits; 2,490 picks over 20 days. Each day was scored by a fit that excluded that day.
  - **By EV:** all picks −7.7%. EV 2–10% −19.9%, EV 10–25% −1.7%, EV over 25% +30.8% (first half +63%, second half +21%).
  - **By price:** NO on heavy favorites (YES ≥ 70¢) +22.9%; NO costing over 60¢ (YES under 40¢) −49.5%.
  - **By projection:** picks where our projection strongly disagrees +4.6%; where it agrees −34.4%.
  - **By confidence grade:** High −8.0%, Medium −7.1%, Low −6.0%, so the grade didn't separate results. Within every grade, EV over 25% was positive and EV under 10% was negative.
- **Changes:**
  - The Edge Board's **minimum EV now defaults to 25%** ("25%+ (recommended)"). Saved boards move to 25% once and can still be changed. Auto bet follows the board's filters.
  - **NBA Kalshi picks priced by the fitted layer** get confidence from edge size and price level (`fittedConfidence`):
    - EV under 10% → Low;
    - EV 10–25% → Medium;
    - NO costing over 60¢ → −40 points;
    - thin market → −10 points.
  - The "Big disagreement: check news" chip is no longer shown on those picks; it stays on other picks.
- **On the current slate:** 80 NBA picks at EV ≥ 25%, all graded High.
- **Caveat:** 20 days of data, and the 10% / 25% cutoffs were chosen after seeing the results.

## 2026-11-12 (owner: "do a more thorough study for the EV brackets")

- **`scripts/ev-study.mjs`:** 21,245 settled Kalshi NBA prop markets for the site's players, Oct 20 – Nov 11 (22 days). It replays the board's rule: one pick per prop, the best EV per $ after fee, cost 20–80¢.
  - **Scoring:** two ways. Leave-one-day-out (LODO), and strictly forward, where each day is fit only on earlier days and the first 5 days are skipped.
  - **Ranges:** 90% ranges come from resampling whole days.
- **ROI by EV bracket (LODO / forward):**

  | EV bracket | LODO | Forward |
  |---|---|---|
  | 2–5% | −22% | −27% |
  | 5–10% | −34% | −24% |
  | 10–15% | −12% | −6% |
  | 15–20% | +10% | +14% |
  | 20–25% | +5% | +3% |
  | 25–30% | +31% | +20% |
  | 30–40% | +44% | +22% |
  | 40%+ | too few to read | too few to read |

  For picks under 10% EV the model was badly overconfident: it expected a 64–70% win rate where 43–45% actually won. At 25%+ it was well calibrated (45% won vs 43–48% expected).
- **Results by minimum-EV cutoff:**

  | Cutoff | Method | Bets | ROI | 90% range | Halves | Days up |
  |---|---|---|---|---|---|---|
  | ≥15% | LODO | 1,151 | +13.0% | +5% … +23% | +12% / +13% | — |
  | ≥15% | Forward | 880 | +13.7% | +5% … +25% | +15% / +14% | — |
  | ≥25% | LODO | 247 | +35.2% | +22% … +50% | +45% / +33% | 17 of 20 |
  | ≥25% | Forward | 318 | +22.3% | +8% … +41% | +26% / +22% | 14 of 16 |

  Last 7 days at ≥25%: +37% (LODO) and +36% (forward). At ≥10% the forward result was +7.4% but the LODO first half was −1.6%. At 2% and 5% it lost (−6% / −3% LODO).
- **Picks at EV ≥ 25%:**
  - all NO bets (points 49, PRA 198);
  - best at a cost of 20–30¢ (+53%), weakest at 30–40¢ (+20%).
- **Decision:** the default stays at 25%; it is the most robust cutoff by both methods. 15% earns less per bet but more in total (about 120 vs 71 units over 17 days at a fixed size) and is positive in both methods and halves, so it's a reasonable choice for more volume. Auto bet already bets the highest-EV picks first.
- **Caveat:** 22 days, and the bracket edges were chosen after looking. Daily tuning re-runs this study.

## 2026-11-12 (owner: "test NFL player props the NBA way")

- **Data:** `scripts/kalshi-history.mjs --league nfl` collected 33,026 settled Kalshi NFL player-prop markets with pre-game quotes, weeks 1–9: passing, rushing and receiving yards, receptions, passing TDs. Anytime-TD markets use a different format and aren't collected yet.
- **Test:** `scripts/nfl-props-study.mjs` ran the same test as for the NBA, scored leave-one-week-out and strictly forward.
- **Calibration** (21,446 markets for the site's 204 NFL players): close to fair everywhere. If anything QB overs ran slightly cheap rather than rich (passing yards priced 30–50¢ hit 46% vs 39%). There is nothing like the NBA's overpriced points/PRA overs.
- **Fitted layer:** the leave-one-week-out log loss (0.48215) was worse than the plain price (0.48198), so the price is better.
- **Board rule:** few picks, and inconsistent between the two halves of the season. EV ≥ 25% strictly forward: 45 bets at −17%. EV ≥ 2%: +3.6% / +4.5% overall, but −5.9% in the second half by leave-one-week-out.
- **Conclusion:** no NFL player-prop edge. Nothing changed on the site; NFL picks keep the 90% market / 10% projection blend.

## 2026-11-12 (owner: "do the same for NHL player props"; "can we check MLB from last season?")

- **Tooling:** `scripts/props-study.mjs --league nfl|nhl|mlb` replaces `nfl-props-study.mjs`. `kalshi-history.mjs` gains the nhl and mlb leagues.
- **NHL** (Oct 6 – Nov 11, 37 days, 27,461 markets; 15,523 for the site's 268 players):
  - **Calibration:** points, goals and assists are close to fair. Overs on points and assists ran slightly cheap, e.g. points priced 70–90¢ hit 80% vs 73%. That's the opposite of the NBA.
  - **Fitted layer:** marginally beat the price (0.48809 vs 0.48937).
  - **Board rule:** lost money, −19% leave-one-day-out and −13% strictly forward on about 230 YES bets. The tiny bias doesn't survive the spread plus fee.
  - **Verdict:** no edge.
- **MLB** (Sep 6 – Oct 28, the end of the regular season through the World Series; 61,001 markets for hits, home runs, strikeouts, total bases and H+R+RBI):
  - **Calibration:** close to fair, e.g. hits priced 50–70¢ hit 61% vs 60%.
  - **Fitted layer:** didn't beat the price (0.48659 vs 0.48649).
  - **Board rule:** −3.3% on 751 bets.
  - **Verdict:** no edge.
  - **Data limit:** Kalshi's live API only keeps about 2 months of settled markets, so earlier regular-season games would need Kalshi's historical API.
- **Overall:** NBA points/PRA remains the only player-prop edge found.

## 2026-11-13 — CORRECTION: the "NO on points/PRA overs" edge was a backtest bug

- **The bug:** `scripts/market-backtest.mjs` matched each Kalshi market to the player's ESPN game by requiring Kalshi's settlement value to equal the final ESPN stat. Kalshi closes a prop market **early when the over hits** and records the stat at that moment (e.g. 15 when 14.5 is crossed), not the final total.
- **The effect:** almost every over that hit was dropped from the backtest. For the site's players, 3,432 markets were dropped, and YES had hit in 95.7% of them, against 65.6% priced. With those missing, overs looked overpriced.
- **Corrected:** markets are matched by date only. On the full 23,886 markets (Oct 20 – Nov 12):
  - the fitted layer equals the plain market price (log loss 0.4962 vs 0.4962), and no stat term survives;
  - no picks reach 10% EV;
  - small-edge picks lose −4% to −12%.
- **Live replay straight from Kalshi results:** the old fit's 25%+ picks returned −37% on Nov 11 and −18% on Nov 12.
- **Changes:**
  - The default edge model is **Conservative** (`market`). The `players` fit is replaced by the corrected one: b0 0.0348, bMid 1.0262, no stat terms.
  - The setting key moved to `edgeMode2`, so earlier "players" choices reset.
  - The Settings wording is updated.
  - On today's slate there are 0 picks at EV ≥ 25%, so Auto bet places nothing.
- **What's still valid:** the NFL, NHL and MLB player-prop studies and the game-line studies (college, tennis, NBA totals) used Kalshi's own results without this matching, so they stand. All of them showed no edge. The entries from 2026-11-12 about the site-players fit, the 25% bracket and the EV brackets are **void**.
