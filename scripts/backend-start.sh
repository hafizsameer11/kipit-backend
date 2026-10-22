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

# If Prisma reports pending migrations, dump the DB first, then apply them.
# (Not `db push` — production uses migrate deploy + migration files.)
migrate_status="$(npx prisma migrate status 2>&1 || true)"
if echo "$migrate_status" | grep -qiE 'not yet been applied|Following migrations have not yet been applied|pending migration'; then
  echo "Pending Prisma migrations detected — taking Postgres backup first"
  bash ./backup-db.sh
else
  echo "No pending Prisma migrations (or status unclear) — skipping pre-migrate backup"
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
