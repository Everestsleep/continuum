#!/usr/bin/env bash
# continuum installer for macOS / Linux
# Usage: curl -fsSL https://raw.githubusercontent.com/Everestsleep/continuum/main/install.sh | bash

set -euo pipefail

REPO="${CONTINUUM_REPO:-Everestsleep/continuum}"
BRANCH="${CONTINUUM_BRANCH:-main}"
INSTALL_DIR="${CONTINUUM_DIR:-$HOME/.continuum}"

say() { printf "\033[1;36m[continuum]\033[0m %s\n" "$*"; }
die() { printf "\033[1;31m[continuum] error:\033[0m %s\n" "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "Node.js 18+ required. Install from https://nodejs.org"
command -v npm  >/dev/null 2>&1 || die "npm required."

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
[ "$NODE_MAJOR" -ge 18 ] || die "Node 18+ required (have $(node -v))"

if command -v git >/dev/null 2>&1; then
  if [ -d "$INSTALL_DIR/.git" ]; then
    say "Updating $INSTALL_DIR..."
    git -C "$INSTALL_DIR" fetch --quiet origin "$BRANCH"
    git -C "$INSTALL_DIR" reset --hard "origin/$BRANCH" --quiet
  else
    say "Cloning $REPO into $INSTALL_DIR..."
    rm -rf "$INSTALL_DIR"
    git clone --depth 1 --branch "$BRANCH" "https://github.com/$REPO.git" "$INSTALL_DIR" --quiet
  fi
else
  say "Downloading tarball..."
  rm -rf "$INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH" \
    | tar -xz -C "$INSTALL_DIR" --strip-components=1
fi

say "Installing dependencies..."
(cd "$INSTALL_DIR" && npm install --silent)

say "Building..."
(cd "$INSTALL_DIR" && npm run build --silent)

# Pick a writable bin dir on PATH
BIN_DIR=""
for d in "/usr/local/bin" "$HOME/.local/bin" "$HOME/bin"; do
  if [ -w "$d" ] || [ ! -e "$d" -a -w "$(dirname "$d")" ]; then
    mkdir -p "$d"
    BIN_DIR="$d"
    break
  fi
done
[ -z "$BIN_DIR" ] && BIN_DIR="$HOME/.local/bin" && mkdir -p "$BIN_DIR"

LINK="$BIN_DIR/continuum"
ln -sf "$INSTALL_DIR/dist/continuum.js" "$LINK"
chmod +x "$INSTALL_DIR/dist/continuum.js"

say "Installed: $LINK -> $INSTALL_DIR/dist/continuum.js"

if ! command -v continuum >/dev/null 2>&1; then
  printf "\n\033[1;33m[continuum] note:\033[0m %s is not on your PATH.\n" "$BIN_DIR"
  printf "  Add this to your shell rc:\n    export PATH=\"%s:\$PATH\"\n" "$BIN_DIR"
fi

say "Done. Try:  continuum --help"
