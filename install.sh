#!/usr/bin/env bash
# install.sh — one-line installer for L3tum's little-coder fork
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/L3tum/little-coder/main/install.sh | bash
set -euo pipefail

say() { printf '\033[1;36m[little-coder]\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m[little-coder]\033[0m %s\n' "$*" >&2; }

# 1. node + npm present?
if ! command -v node >/dev/null 2>&1; then
  err "Node.js not found. Install Node 22.19+ from https://nodejs.org or via nvm: 'nvm install 22'."
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  err "npm not found. It usually ships with Node.js — reinstall Node from https://nodejs.org."
  exit 1
fi

# 2. node >= 22.19.0 (matches @earendil-works/pi-coding-agent's minimum)
NODE_V=$(node -p "process.versions.node")
if ! node -e '
  const [a,b] = process.versions.node.split(".").map(Number);
  if (a < 22 || (a === 22 && b < 19)) process.exit(1);
'; then
  err "Node $NODE_V is too old. little-coder needs >= 22.19.0."
  err "Try: nvm install 22 && nvm use 22"
  exit 1
fi
say "Node $NODE_V detected."

# 3. install
say "Installing little-coder fork globally from GitHub..."
if npm install -g github:L3tum/little-coder; then
  say "Installed."
  say "Run:    cd ~/your-project && little-coder --model llamacpp/qwen3.6-35b-a3b"
  say "Models: little-coder --list-models"
else
  err "Install failed."
  err "If it was a permissions error (EACCES), one of these usually fixes it:"
  err "  sudo npm install -g github:L3tum/little-coder"
  err "  or configure a user-writable npm prefix:"
  err "  https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally"
  exit 1
fi
