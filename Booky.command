#!/bin/bash
# Double-click to start booky. Pulls the latest version first, then runs the app.
# Keep this file inside the repo; put an alias to it on the Desktop.
cd "$(dirname "$(readlink -f "$0")")" || exit 1
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

echo "booky · updating..."
if ! git pull --ff-only --quiet; then
  echo "could not update (offline or local changes) - running the current version"
fi

if ! command -v uv >/dev/null; then
  echo "uv is not installed. Run 'just install' or: brew install uv"
  read -n 1 -s -r -p "press any key to close"
  exit 1
fi

echo "booky · starting (close this window to quit)"
exec uv run booky.py
