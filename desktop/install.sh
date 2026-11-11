#!/bin/bash
# Install (or update) PropLab for Mac:
#   curl -fsSL https://raw.githubusercontent.com/Alex-Palmas/sports/main/desktop/install.sh | bash
set -euo pipefail
case "$(uname -m)" in arm64) arch=arm64 ;; *) arch=x64 ;; esac
url="https://github.com/Alex-Palmas/sports/releases/download/desktop-latest/PropLab-mac-$arch.zip"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo "Downloading PropLab for Mac ($arch)…"
curl -fL --progress-bar -o "$tmp/PropLab.zip" "$url"
ditto -x -k "$tmp/PropLab.zip" "$tmp/app"
osascript -e 'quit app "PropLab"' >/dev/null 2>&1 || true
dest="/Applications/PropLab.app"
if [ -d "$dest" ]; then mv "$dest" "$tmp/old.app"; fi
mv "$tmp/app/PropLab.app" "$dest"
# the app is built by GitHub Actions and ad-hoc signed (not notarized): clear the download quarantine flag
xattr -cr "$dest" 2>/dev/null || true
echo "Installed $dest"
open "$dest"
