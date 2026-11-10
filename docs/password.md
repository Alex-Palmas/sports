# Site password

PropLab asks for a password before showing the app. An unlock lasts only for that browser tab/session; **Lock** in Settings (⚙) locks it right away. Every page load re-checks against the current password file, so you can lock everyone out at any time (below).

## Changing the password

```sh
node scripts/set-password.mjs                  # generates a strong password and prints it once
node scripts/set-password.mjs 'my passphrase'  # or choose your own (10+ characters)
```

Then commit `site/access.json` and push; the site uses it after the next deploy. Only a salted PBKDF2-SHA256 hash (310,000 iterations) is stored, never the password.

## Locking every device

```sh
node scripts/set-password.mjs --lock-all   # same password, but everyone has to enter it again
```

Commit and push `site/access.json`. Changing the password does the same. Each device checks on its next page load (GitHub Pages can keep serving the previous page for up to ~10 minutes after a deploy).

## What this protects (and what it doesn't)

GitHub Pages only serves static files, so the check runs in the browser. It keeps casual visitors out of the app, but it is not server-side security: the data files (`data.json` etc.) and the repository are public, and anyone determined can read them directly. Use a long password: the hash is public, so a short one could be guessed offline.
