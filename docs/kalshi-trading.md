# Placing Kalshi bets from PropLab

PropLab can send a real order to your Kalshi account for a prop you like. It's off until you turn it on.

## Setup (once)

1. **API key.** On kalshi.com: Account & security → API keys → Create key. Save the key ID and the private key file (it's shown only once).
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
