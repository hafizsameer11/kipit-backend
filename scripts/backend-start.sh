#!/usr/bin/env bash
# Started by systemd backend.service from /var/www/backend.
set -euo pipefail
cd "$(dirname "$0")"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

npx prisma migrate deploy
node dist/worker.js &
WORKER_PID=$!
node dist/index.js &
API_PID=$!

term() {
  kill "$WORKER_PID" "$API_PID" 2>/dev/null || true
}
trap term EXIT INT TERM

wait -n
exit $?
