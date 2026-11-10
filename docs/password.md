# Site password

PropLab asks for a password before showing the app. Enter the right one and the device stays unlocked for 30 days ("Remember this device"), or until the browser closes if you untick it. **Lock** in Settings (⚙) locks it again.

## Changing the password

```sh
node scripts/set-password.mjs                  # generates a strong password and prints it once
node scripts/set-password.mjs 'my passphrase'  # or choose your own (10+ characters)
```

Then commit `site/access.json` and push; the site uses it after the next deploy. Only a salted PBKDF2-SHA256 hash (310,000 iterations) is stored, never the password. Devices that are already unlocked stay unlocked until they press Lock.

## What this protects (and what it doesn't)

GitHub Pages only serves static files, so the check runs in the browser. It keeps casual visitors out of the app, but it is not server-side security: the data files (`data.json` etc.) and the repository are public, and anyone determined can read them directly. Use a long password: the hash is public, so a short one could be guessed offline.
