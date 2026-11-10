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

## Deploy
`.github/workflows/pages.yml` fetches fresh data every 3 hours (and on every push to `main`) and publishes `site/` to GitHub Pages.
One-time setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

## Run locally
```sh
node --test                        # parser tests
node scripts/fetch-data.mjs        # writes site/data.json (Node 22+)
cd site && python3 -m http.server  # open http://localhost:8000
```
