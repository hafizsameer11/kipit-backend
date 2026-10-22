#!/usr/bin/env bash
# Deprecated local helper. Production deploys use GitHub Actions + /usr/local/bin/deploy.
# See docs/SERVER_DEPLOY.md
echo "Use GitHub Actions on main, or on the VPS: /usr/local/bin/deploy backend" >&2
exit 1
