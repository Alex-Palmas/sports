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
`scripts/kalshi-latency.mjs` follows every **NBA and NFL** game live: ESPN's play-by-play against **every Kalshi market for that game** (moneyline, spread, totals, quarters and halves, player props, specials). It finds each game's markets from its Kalshi moneyline event, so it never scans all of Kalshi.

**Game tracker.** For each game, every market's pre-game and final price, low–high range, contracts traded and number of moves, plus how fast each market type starts repricing and gets 50% repriced after key plays (scores, and NFL turnovers). It also records the home team's win probability through the game. Kalshi is polled by market type within its public rate limit of about 4 requests a second: moneyline, spread, total and the headline prop every few seconds, other markets in rotation. Each type's refresh interval is reported, and price changes are timed with Kalshi's own update stamp.

**Prop latency.** For every play that settles a player prop (NBA points/rebounds/assists/threes; NFL passing/rushing/receiving yards, receptions, touchdowns), it records:
- **when the play happened** (ESPN's wallclock stamp),
- **when the feed delivered it**,
- **when Kalshi caught up** (YES bid reached 90¢, or Kalshi closed the market),
- **the full price path** for two minutes: total move, time to start / 50% / 90%, price steps, contracts traded, and how much of the move was left when the feed delivered the play,
- **the stale price** Kalshi still showed then, and the profit per contract after fees.

NBA game-line moves after each score are analysed the same way, split by situation.

**Player events.** Every stat change for a player with Kalshi lines is recorded, not just the ones that cross a line, together with the price path of the player's next two lines up. Each game view lists every player with Kalshi lines: live stats against each line, its price now and its change since tip-off.

**Trading simulator.** The tab replays the recorded top of the order book (best bid, ask and size from −10s to +2 min around each play) as paper trades. It never places orders.
- *Settled props*: buy the line a play just settled, hold to $1.
- *Player events*: after a stat change, buy the player's next line up and sell after the hold.
- *Game line*: after a score, buy the scoring team and sell after the hold.

You set your feed delay (the recorded ESPN delay, or a hypothetical faster feed), order delay, max price, contracts and hold time. Fills use the recorded best price and size and include Kalshi's taker fee. Queue position, market impact and stat corrections are not modelled, so results are a best case.

`.github/workflows/kalshi-latency.yml` runs at about 11:45am, 5:15pm and 11pm ET. Each run follows whatever games are live or start within 4 hours. While games are on, it pushes a snapshot to the `live-data` branch every 3 minutes, which the app's **Kalshi Latency Study** tab reads for live games. At the end it commits the full recording to `site/latency/`. It only reads data and never places orders.

Run it yourself (the NBA's own CDN feed only works from a home connection):
```sh
LEAGUES=nba,nfl node scripts/kalshi-latency.mjs
FEED=nba LEAGUES=nba node scripts/kalshi-latency.mjs
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
