#!/usr/bin/env bash
# Deploy Kipit API + worker on the VPS (main branch only).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> Kipit backend deploy @ $(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [[ ! -f .env ]]; then
  echo "ERROR: missing .env in $ROOT" >&2
  exit 1
fi

# VPS clone should use the Kipitapp GitHub repo as `origin`.
git fetch origin
git checkout main
git reset --hard origin/main

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo "ERROR: Node 20+ required (found $(node -v 2>/dev/null || echo none))" >&2
  exit 1
fi

npm ci
npx prisma generate
npx prisma migrate deploy
npm run build

if command -v pm2 >/dev/null 2>&1; then
  pm2 startOrReload ecosystem.config.cjs --update-env
  pm2 save
else
  echo "WARN: pm2 not found — built dist/ only. Start API with: npm run start"
fi

echo "==> Backend deploy complete"
