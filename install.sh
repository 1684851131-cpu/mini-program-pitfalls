#!/usr/bin/env bash
# Install both skills into a Hermes skills directory.
# Backs up an existing same-named skill instead of overwriting it silently.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)/skills"

# Pick a destination: arg > $HERMES_SKILLS_DIR > platform default.
if [ "${1:-}" != "" ]; then
  DEST="$1"
elif [ -n "${HERMES_SKILLS_DIR:-}" ]; then
  DEST="$HERMES_SKILLS_DIR"
elif [ "$(uname -s 2>/dev/null || echo unknown)" = "Darwin" ]; then
  DEST="$HOME/.hermes/skills"
elif [ -n "${LOCALAPPDATA:-}" ]; then
  DEST="$LOCALAPPDATA/hermes/skills"
else
  DEST="$HOME/.hermes/skills"
fi

if [ ! -d "$SRC" ]; then
  echo "error: $SRC not found — run this script from the repository root" >&2
  exit 1
fi

mkdir -p "$DEST"
STAMP="$(date +%Y%m%d-%H%M%S)"
echo "source: $SRC"
echo "target: $DEST"

for pkg in "$SRC"/*/; do
  name="$(basename "$pkg")"
  if [ -e "$DEST/$name" ]; then
    mv "$DEST/$name" "$DEST/$name.bak-$STAMP"
    echo "  backed up existing $name -> $name.bak-$STAMP"
  fi
  cp -R "$pkg" "$DEST/$name"
  echo "  installed $name"
done

echo
echo "done. restart Hermes (or reload skills) to pick them up."
echo "rollback: mv \"$DEST/<name>.bak-$STAMP\" \"$DEST/<name>\""
