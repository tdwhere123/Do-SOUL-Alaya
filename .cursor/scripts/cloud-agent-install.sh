#!/usr/bin/env bash
set -euo pipefail

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck source=/dev/null
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

nvm install 24
nvm use 24
# Persist Node 24 as the nvm default so fresh agent shells (whose corepack/pnpm
# resolve through nvm) satisfy the repo's engines.node >=24 with engine-strict.
nvm alias default 24
node --version

corepack enable
corepack prepare pnpm@12.3.4 --activate
export CI=true
pnpm install --frozen-lockfile
pnpm build
