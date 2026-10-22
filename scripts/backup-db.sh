#!/usr/bin/env bash
# Dump Postgres to /home/deploy/backups/postgres before applying migrations.
# Requires: pg_dump on the server PATH, DATABASE_URL in env or .env
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "backup-db: DATABASE_URL is not set — skip" >&2
  exit 0
fi

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "backup-db: pg_dump not found — install postgresql-client" >&2
  exit 1
fi

BACKUP_DIR="${BACKUP_DIR:-/home/deploy/backups/postgres}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${BACKUP_DIR}/kipit-${STAMP}.sql.gz"

echo "backup-db: writing ${OUT}"
# URI form works with modern pg_dump (Postgres 13+)
pg_dump --no-owner --no-acl --format=plain "$DATABASE_URL" | gzip -c >"$OUT"
chmod 600 "$OUT"

# Drop backups older than KEEP_DAYS
find "$BACKUP_DIR" -type f -name 'kipit-*.sql.gz' -mtime "+${KEEP_DAYS}" -delete 2>/dev/null || true

echo "backup-db: done ($(du -h "$OUT" | awk '{print $1}'))"
ls -lt "$BACKUP_DIR"/kipit-*.sql.gz 2>/dev/null | head -n 5 || true
