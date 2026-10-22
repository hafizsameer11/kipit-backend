# Server deploy (tarball + `/usr/local/bin/deploy`)

Production paths:

| App | Path | Archive | systemd |
|---|---|---|---|
| web | `/var/www/web` | `/home/deploy/incoming/web.tar.gz` | `web.service` |
| admin | `/var/www/admin` | `/home/deploy/incoming/admin.tar.gz` | `admin.service` |
| backend | `/var/www/backend` | `/home/deploy/incoming/backend.tar.gz` | `backend.service` |

Merge to **`main`** triggers GitHub Actions → build → `scp` tarball → `deploy <app>`.  
Pull requests only run CI; they do **not** deploy.

Secrets stay in `/var/www/backend/.env` (and web/admin env if needed). Deploy never overwrites `.env`, `storage/`, or `uploads/`.

---

## 1. Install `/usr/local/bin/deploy`

```bash
sudo tee /usr/local/bin/deploy >/dev/null <<'EOF'
#!/bin/bash
# Usage: deploy web|admin|backend
# Archive must already be at /home/deploy/incoming/<app>.tar.gz
set -euo pipefail
umask 022
usage() {
  echo "usage: deploy web|admin|backend" >&2
  exit 64
}
[[ $# -eq 1 ]] || usage
APP="$1"
case "$APP" in
  web|admin|backend) ;;
  *) usage ;;
esac
ARCHIVE="/home/deploy/incoming/${APP}.tar.gz"
DEST="/var/www/${APP}"
[[ -f "$ARCHIVE" ]] || { echo "missing archive: $ARCHIVE" >&2; exit 1; }
if tar -tzf "$ARCHIVE" | grep -Eq '(^|/)\.\.(/|$)|^/'; then
  echo "archive contains unsafe paths" >&2
  exit 1
fi
mkdir -p /home/deploy/incoming /home/deploy/staging "$DEST"
chmod 700 /home/deploy/incoming /home/deploy/staging
STAGING="$(mktemp -d /home/deploy/staging/${APP}.XXXXXX)"
trap 'rm -rf "$STAGING"' EXIT
tar -xzf "$ARCHIVE" -C "$STAGING"
[[ -n "$(ls -A "$STAGING")" ]] || { echo "archive was empty" >&2; exit 1; }
chmod 755 "$STAGING" "$DEST"
rsync -a --delete --chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r \
  --exclude '.env' \
  --exclude 'storage/' \
  --exclude 'uploads/' \
  "$STAGING"/ "$DEST"/
chmod 755 "$DEST"
rm -f "$ARCHIVE"
if systemctl cat "${APP}.service" >/dev/null 2>&1; then
  sudo -n /bin/systemctl restart "${APP}.service"
fi
echo "deployed ${APP} to ${DEST}"
EOF
sudo chmod 755 /usr/local/bin/deploy
```

Directories:

```bash
sudo install -d -m 755 -o root -g root /var/www
sudo install -d -m 755 -o deploy -g deploy /var/www/web /var/www/admin /var/www/backend
sudo install -d -m 700 -o deploy -g deploy /home/deploy/incoming /home/deploy/staging
```

Sudoers (`visudo -cf /etc/sudoers.d/deploy`):

```
deploy ALL=(root) NOPASSWD: /bin/systemctl restart web.service, /bin/systemctl restart admin.service, /bin/systemctl restart backend.service
```

---

## 2. systemd units

### `/etc/systemd/system/web.service`

```ini
[Unit]
Description=Kipit web
After=network.target

[Service]
Type=simple
User=deploy
Group=deploy
WorkingDirectory=/var/www/web
Environment=NODE_ENV=production
Environment=PORT=3002
Environment=HOST=127.0.0.1
Environment=NITRO_PORT=3002
Environment=NITRO_HOST=127.0.0.1
ExecStart=/usr/bin/node server/index.mjs
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### `/etc/systemd/system/admin.service`

Same as web, but `WorkingDirectory=/var/www/admin` and ports `3001`.

### `/etc/systemd/system/backend.service`

```ini
[Unit]
Description=Kipit backend API + worker
After=network.target postgresql.service redis.service

[Service]
Type=simple
User=deploy
Group=deploy
WorkingDirectory=/var/www/backend
Environment=NODE_ENV=production
EnvironmentFile=-/var/www/backend/.env
ExecStart=/var/www/backend/start.sh
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now web.service admin.service backend.service
```

---

## 3. GitHub

Secrets on each repo: `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`, `VPS_KNOWN_HOSTS`.

Protect `main`: require PR, no direct push, no force-push.

---

## 4. Ship a change

1. Branch from `main` (`feat/…`)
2. Open PR → CI runs
3. Merge PR → Deploy workflow builds + uploads tarball
4. Server: `ls /var/www/web` `/var/www/admin` `/var/www/backend`

---

## 5. Database backups (before migrations)

### What production does

On every backend start, `start.sh` runs:

1. `prisma migrate status`
2. If there are **pending** migrations → `backup-db.sh` (`pg_dump` → gzip)
3. `prisma migrate deploy` (never `db push` in production)

Backups land in:

```text
/home/deploy/backups/postgres/kipit-YYYYMMDDTHHMMSSZ.sql.gz
```

Kept for **14 days** (`BACKUP_KEEP_DAYS`). Override with env if needed.

### One-time server prep

```bash
sudo apt-get install -y postgresql-client
sudo install -d -m 700 -o deploy -g deploy /home/deploy/backups/postgres
```

`deploy` must be able to reach Postgres using `DATABASE_URL` from `/var/www/backend/.env`.

### Restore (emergency)

```bash
# stop API first
sudo systemctl stop backend.service

gunzip -c /home/deploy/backups/postgres/kipit-TIMESTAMP.sql.gz \
  | psql "$DATABASE_URL"

sudo systemctl start backend.service
```

### Other options (choose what you want later)

| Option | Pros | Cons |
|---|---|---|
| **A. Pre-migrate dump (what we ship)** | Automatic when schema changes; tied to deploys | Only runs when migrations are pending |
| **B. Daily cron `pg_dump`** | Covers “no deploy for weeks” | Extra disk; still need retention |
| **C. Host/managed backups** (DO, AWS RDS, etc.) | Point-in-time recovery | Provider-specific; still keep A or B |
| **D. WAL archiving / PITR** | Best recovery granularity | More ops work |

Recommended: **A + B** (migration-triggered + nightly), and **C** if the DB is managed.

### Optional nightly cron (as `deploy`)

```bash
crontab -e
# daily 02:15 UTC
15 2 * * * cd /var/www/backend && /bin/bash ./backup-db.sh >> /home/deploy/backups/postgres/cron.log 2>&1
```

