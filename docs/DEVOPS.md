# Kipit backend — DevOps

## Branch rules

| Branch | Purpose |
|---|---|
| `main` | Production. VPS auto-deploys from here only. |
| `feat/*`, `fix/*`, `chore/*` | Day-to-day work. Never push straight to `main`. |

Workflow:

1. Create a branch from `main`
2. Push the branch
3. Open a **Pull Request** into `main`
4. CI runs (typecheck)
5. Merge the PR → GitHub Actions deploys to the VPS

Protect `main` in GitHub: Settings → Branches → require PR + status checks.

## Remotes

- `origin` — internal / previous remote (optional)
- `client` — **client org** `https://github.com/Kipitapp/kipit-backend.git` (source of truth for Kipit)

```bash
git remote add client https://github.com/Kipitapp/kipit-backend.git
git push -u client main
```

## Auto deploy

On every push to `main` (including PR merges), `.github/workflows/deploy.yml` SSHs into the VPS and runs `scripts/deploy.sh`.

Enable after secrets are set:

- Repository **variable**: `ENABLE_AUTO_DEPLOY=true`
- Repository **secrets**: see server checklist below

### Coolify (optional)

Coolify is fine if you want a UI for deploys. Point a Coolify resource at this repo, branch `main`, build/start commands matching `scripts/deploy.sh`. Do **not** run both Coolify and GitHub Actions deploy on the same path or they will fight.

## Local deploy test on VPS

```bash
cd /var/www/kipit-backend
bash scripts/deploy.sh
```
