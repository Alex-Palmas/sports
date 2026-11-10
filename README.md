# PropLab — Player Prop Research

A static web app for researching player props: hit rates over the last 5/10/20 games, bar-chart game logs against the line, alt-line hit rates, home/away/head-to-head splits and opponent matchup ranks for NBA, NFL, NHL and MLB.

## Data
`scripts/fetch-data.mjs` builds `site/data.json` from real sources:

| What | Source | Cost |
|---|---|---|
| Upcoming games, rosters, injuries, player game logs (this + last season) | ESPN public site API | Free, no key |
| Prop prices from DraftKings, FanDuel, BetMGM, Caesars, ESPN BET, BetRivers, Fanatics, … | [The Odds API](https://the-odds-api.com) | Free tier: 500 credits/month, key required |
| Prediction-market prices for player props (every strike on the ladder) | [Kalshi](https://kalshi.com) public market-data API | Free, no key |

### Line shopping
For every prop, the app lists each book's line and over/under price side by side:
- **Best line**: the lowest over line and the highest under line across books, with price as the tie-breaker. Kalshi takes part through its strike closest to 50/50.
- **Best price at each line** is bolded.
- **Est. EV**: our probability is the player's last-20 hit rate at that line, pulled toward the market's no-vig price (prior worth 10 games). Only prices with a 20–80% fair probability are ranked, so small samples can't turn long shots into "locks". Sort the list by **Best value (EV)** and tick **Only props with sportsbook / Kalshi prices** to see the best-priced bets across every book.
- Kalshi prices include its taker fee (≈ 7%·p·(1−p) per contract) and are converted to American odds. Kalshi markets with no real two-sided quote, or a spread wider than 12¢, are skipped.

Props with no market anywhere get a **projected** line (the x.5 value the player cleared in ~50% of their last 20 games), tagged `PROJ`. Opponent ranks are computed from the collected game logs. If `data.json` is missing, the app falls back to fictional demo data in `site/data.js`.

### Add sportsbook prices
1. Get a free key at https://the-odds-api.com.
2. Repo **Settings → Secrets and variables → Actions → New repository secret**: `ODDS_API_KEY`.
3. Odds are fetched once a day, capped at 16 credits per run (~480/month). One request returns every book in the region, so adding books costs nothing extra. To change this, set the Actions variables `ODDS_MAX_CREDITS` and `ODDS_REGIONS` (e.g. `us,us2` adds Hard Rock and others at 2× cost), or run the workflow manually with "fetch odds" ticked.

Kalshi needs no setup and refreshes every 3 hours.

### Arbitrage
The **⇄ Arbitrage** view scans every prop for an over at one book plus an under at another that guarantees a profit (margin = 1/(1/d₁ + 1/d₂) − 1 with decimal odds). It shows the stake split for any total, and flags **middles**, where the over line is below the under line so both legs can win, along with how often the player landed in that window over their last 20 games. Arbs need prices from several books, so add `ODDS_API_KEY`. Prices move and books limit arbers, so re-check both legs before betting.

## Kalshi Latency Study
Does a free live feed see NBA plays before Kalshi reprices? `scripts/kalshi-latency.mjs` polls a play-by-play feed and Kalshi's public market data about once a second while games are live. For every play that settles a Kalshi player prop (a basket that takes a player past 20 points settles "20+ points" as YES), it records:
- **when the play happened** (the feed's wallclock stamp),
- **when the feed delivered it**,
- **when Kalshi caught up** (YES bid reached 90¢, or Kalshi closed the market),
- **the stale price** Kalshi still showed when the feed delivered the play, and the profit per contract after fees.

It also follows the **whole price path** for up to two minutes after each play, to show how long repricing takes once it starts:
- how far the implied probability moved,
- when the move started, and when it was 50% and 90% done,
- how many separate price steps it took, and how many contracts traded meanwhile (a steady drift as people trade, or one jump by market makers),
- how much of the move was still left when the feed delivered the play.

The same path is measured on Kalshi's game-winner market after every scoring play. Each window ends at the next score, and results are split by situation (clutch vs. the rest, 1/2/3 points). `.github/workflows/kalshi-latency.yml` runs it every evening at about 6:50pm ET (and late morning on weekends) and commits the results to `site/latency/`, and the app's **Kalshi Latency Study** tab shows them. It only reads data and never places orders.

Feeds: `FEED=espn` (default) works from GitHub's servers. `FEED=nba` uses the NBA's official CDN, which is usually faster but blocks cloud servers, so run it from a home connection:
```sh
FEED=nba node scripts/kalshi-latency.mjs   # results land in site/latency/
```

## Deploy
`.github/workflows/pages.yml` fetches fresh data every 3 hours (and on every push to `main`) and publishes `site/` to GitHub Pages.
One-time setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

## Run locally
```sh
node --test                        # parser tests
node scripts/fetch-data.mjs        # writes site/data.json (Node 22+)
cd site && python3 -m http.server  # open http://localhost:8000
```
