# Sign-in and accounts

PropLab shows a sign-in screen before the app. Each account gets its own bets, watchlist, bankroll, Edge Board settings and saved Kalshi key on each device. The first account to sign in on a device inherits whatever that device had saved before sign-in existed.

## Managing accounts

```sh
node scripts/add-user.mjs alex --name "Alex"          # generates and prints a strong password
node scripts/add-user.mjs alex 'my-own-passphrase'    # or set one (10+ characters)
node scripts/add-user.mjs --list
node scripts/add-user.mjs --remove alex
```

Then commit `site/users.json` and push. The site picks it up on the next deploy. Only a salted PBKDF2-SHA256 hash (310,000 iterations) is stored, never the password.

## What this protects (and what it doesn't)

GitHub Pages only serves static files, so the check runs in the browser. It keeps casual visitors out of the app and separates each person's data, but it is not server-side security: the data files (`data.json` etc.) and the repository are public, and anyone determined can read them directly. Use long, generated passwords: the hashes are public, so short passwords could be guessed offline.

For real accounts (sign-up, password reset, data that follows you across devices, private data), the site would need a hosted auth service such as Supabase or Firebase Auth, or the repository made private with access-controlled hosting.
