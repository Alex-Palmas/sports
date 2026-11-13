# Placing Kalshi bets from PropLab

PropLab can send a real order to your Kalshi account for a prop you like. It's off until you turn it on.

## Easiest: the Mac app

```sh
curl -fsSL https://raw.githubusercontent.com/Alex-Palmas/sports/main/desktop/install.sh | bash
```

PropLab for Mac shows the live website (always the current version) and has the relay built in, so there's nothing else to run: open Settings, add your key, Test connection. Run the same command again to update the app shell (rarely needed). Built by `.github/workflows/desktop.yml` into the `desktop-latest` release.

## Setup in a browser (once)

1. **API key.** On kalshi.com: Account & security → API keys → Create key (RSA or Ed25519 both work). Save the key ID and the private key (it's shown only once). PropLab accepts the PEM file, or for Ed25519 the bare key as base64 or hex.
2. **Relay.** Kalshi blocks requests coming from web pages, so the site sends its orders through a tiny relay you control. The relay never sees your key; it only forwards requests your browser has already signed.
   - **On a computer:** `node scripts/kalshi-relay.mjs` (Node 18+). Leave the relay URL as `http://localhost:8787`.
   - **From your phone:** create a free Cloudflare Worker (dash.cloudflare.com → Workers & Pages → Create → Hello World → Edit code), replace its code with `relay/kalshi-relay-worker.mjs`, deploy, and use the worker's `https://….workers.dev` URL.
3. **In PropLab:** ⚙ Settings → paste the key ID and private key (or load the file) → set the relay URL → Test connection (shows your balance) → tick "Enable placing orders" → Save.

## Placing a bet

Open a prop that has a Kalshi market and tap **Bet on Kalshi**. The ticket:

- starts on the Edge Board's pick for that prop (you can choose another strike or side),
- fetches the **live** price and shows how far it has moved since the last data refresh,
- recomputes our probability and EV at that live price and suggests a quarter-Kelly stake,
- caps the stake at your max per order (fees included),
- sends an **immediate-or-cancel** limit order at the current ask: it fills now at that price or better, or nothing happens. Nothing is left resting on the book.

You have to tick the confirmation box for every order. Filled orders are added to My Bets (marked "real") and settle from ESPN box scores like the rest.

## Security

- The private key is imported as a non-extractable WebCrypto key and stored in this browser's IndexedDB. The page can sign with it but can't read it back; the PEM text is never stored.
- Anyone using this browser profile could place orders with it. Use a separate profile on shared devices, and remove the key in Settings when you're done. Kalshi API keys can trade but can't withdraw.
- All `*.github.io` project pages of the same account share one browser origin. Only keep the key in a profile you use for this site.

## Opening a bet in the Kalshi app

Every Kalshi price links to its market page on kalshi.com (the game's event page, e.g. `kalshi.com/markets/kxnbapts/nba-player-points/kxnbapts-26nov10orlsac`, where every player and threshold for that game is listed). The links are on the prop page (**Open in Kalshi**), each Kalshi row in Line shopping, Edge Board picks priced on Kalshi, the order ticket, and real bets in My Bets. On a phone with the Kalshi app installed, the phone opens these kalshi.com links in the app; otherwise they open in the browser.

## "Insufficient balance" with money in the account

Kalshi keeps your cash split across exchange shards and fills each order from the shard its market trades on.
Settings → Test connection lists the balance on each shard. When an order fails with "insufficient balance",
PropLab looks up the market's shard. If your money is on a different shard, it asks before moving just enough
over (Kalshi's intra-exchange transfer) and then retries the order once. If the move is refused, the API key may
need the transfer permission, or you can move the funds on kalshi.com.

## Auto bet

Tick **Auto bet** on the Edge Board to let PropLab place bets for you.

- **What it bets on:** every Kalshi pick the board is showing with your current filters, as long as it has positive EV after fees and its game hasn't started. When a new pick appears in the minute-by-minute refresh, the bot bets on that too. It places one bet per pick.
- **Settings → Auto bet bot:**
  - **Each bet (% of account)**, default 1%.
  - **Max in open bets (% of account)**, default 50%.
- **How the money works:**
  - Every 5 minutes the bot reads your Kalshi cash and open positions; your account is cash plus money in open bets. It also re-checks right away whenever it would have to skip a pick for lack of room.
  - Each bet is its % of the account, at least one contract and never more than "Max per order".
  - New bets are placed only while the money in open bets stays under the limit and there's cash for them.
  - When bets settle, their money is free again (including winnings) and goes into the next picks on the board.
  - The open-bets total includes bets you placed yourself.
- **Orders:** orders are immediate-or-cancel at the live ask. If the price moved, the bot buys only if the edge still holds at the new price.
- **Stopping:** the bot stops itself on any error other than a skipped pick, such as a rejected key or insufficient funds. The reason shows in the bot box on the Edge Board.
- **When it runs:** only while PropLab is open (the Mac app or a browser tab). It keeps running if you switch tabs inside PropLab, and it resumes after a reload.
- **Records:** every bot bet is listed in My Bets, marked "bot".

### Bet window (2026-11-13)
Auto bet only places a pick within **2 hours of the game's start** (Settings → Auto bet bot → "Bet only within (hours before the game)", 0.25–48 h). Picks for later games wait on the board; the bot status shows when the first window opens. Picks with no known start time are not bet.
