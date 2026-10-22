# Kipit backend — DevOps

## Branch rules

| Branch | Purpose |
|---|---|
| `main` | Production. Merge here → GitHub Actions builds and deploys. |
| `feat/*`, `fix/*`, `chore/*` | Work branches. Open a PR into `main`. Never push straight to `main`. |

Protect `main`: require PR + CI status checks; no force-push.

## Remotes

- `client` — https://github.com/Kipitapp/kipit-backend.git (source of truth)

## Deploy

See [SERVER_DEPLOY.md](./SERVER_DEPLOY.md).

On push to `main`, Actions packs the runtime folder (compiled `dist`, Prisma, production `node_modules`, `start.sh`), uploads `/home/deploy/incoming/backend.tar.gz`, and runs `/usr/local/bin/deploy backend` → `/var/www/backend`.
