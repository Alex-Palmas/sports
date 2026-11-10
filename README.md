# PropLab — Player Prop Research

A static web app for researching player props: hit rates over the last 5/10/20 games, bar-chart game logs against the line, alt-line hit rates, home/away/head-to-head splits and opponent matchup ranks for NBA, NFL, NHL and MLB.

## Data
`scripts/fetch-data.mjs` builds `site/data.json` from real sources:

| What | Source | Cost |
|---|---|---|
| Upcoming games, rosters, injuries, player game logs (this + last season) | ESPN public site API | Free, no key |
| Sportsbook prop lines & odds | [The Odds API](https://the-odds-api.com) | Free tier: 500 credits/month, key required |

Without an Odds API key every line is a **projection** (the x.5 value the player cleared in ~50% of their last 20 games) and is tagged `PROJ` in the app. Opponent ranks are computed from the collected game logs.

If `data.json` is missing (e.g. opening `site/index.html` directly), the app falls back to fictional demo data in `site/data.js`.

### Add real sportsbook lines (optional)
1. Get a free key at https://the-odds-api.com.
2. Repo **Settings → Secrets and variables → Actions → New repository secret**: `ODDS_API_KEY`.
3. Odds are fetched once a day, capped at 16 credits per run (~480/month). Change with an Actions variable `ODDS_MAX_CREDITS`, or run the workflow manually with "fetch odds" ticked.

## Deploy
`.github/workflows/pages.yml` fetches fresh data every 3 hours (and on every push to `main`) and publishes `site/` to GitHub Pages.
One-time setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

## Run locally
```sh
node scripts/fetch-data.mjs        # writes site/data.json (Node 22+)
cd site && python3 -m http.server  # open http://localhost:8000
```
