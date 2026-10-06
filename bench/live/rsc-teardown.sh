#!/usr/bin/env bash
# Delete the three temporary rsc-live Workers and prove it: wrangler deployments list must then fail with "not found". Needs CLOUDFLARE_API_TOKEN.
set -uo pipefail
export PATH=$HOME/cf-lite-live/tool/node_modules/.bin:$PATH
for n in tmp-rsclive-lite tmp-rsclive-ssr tmp-rsclive-vinext; do wrangler delete --name "$n" --force 2>&1 | tail -2; done
echo "--- proof (each must report that the Worker does not exist):"
for n in tmp-rsclive-lite tmp-rsclive-ssr tmp-rsclive-vinext; do echo "[$n]"; wrangler deployments list --name "$n" 2>&1 | tail -3; echo "workers.dev: $(curl -s -m15 -o /dev/null -w '%{http_code}' https://$n.ACCOUNT.workers.dev/)"; done
