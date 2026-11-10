# PropLab — Player Prop Research

A static web app for researching player props: hit rates over the last 5/10/20 games, bar-chart game logs against the line, alt-line hit rates, home/away and head-to-head splits, and opponent matchup ranks. Covers NBA, NFL, MLB and NHL.

**Demo data:** players, teams and stats are fictional and generated in `site/data.js`. To use real data, replace `window.PROPLAB_DATA` with the same shape (documented at the top of that file).

## Run locally
Open `site/index.html` in a browser — no build step.

## Deploy
`.github/workflows/pages.yml` publishes `site/` to GitHub Pages on every push to `main`.
One-time setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
