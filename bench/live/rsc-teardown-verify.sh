#!/usr/bin/env bash
# Proof that the temporary rsc-live Workers are gone. Needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID  (from the environment); never prints the token.
set -uo pipefail
export PATH=$HOME/cf-lite-live/tool/node_modules/.bin:$PATH
for n in tmp-rsclive-lite tmp-rsclive-ssr tmp-rsclive-vinext; do
  echo "[$n]"; wrangler deployments list --name "$n" 2>&1 | grep -v '^$' | grep -iv 'logs were written' | head -n 4
  echo "workers.dev: $(curl -s -m15 -o /dev/null -w '%{http_code}' "https://$n.ACCOUNT.workers.dev/")"
done
echo "--- scripts in the account (API list):"
bash -c 'curl -s -m20 "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"' \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); n=[x["id"] for x in d.get("result",[])]; print("api success:", d.get("success"), "| scripts total:", len(n), "| tmp-rsclive*:", [x for x in n if x.startswith("tmp-rsclive")])'
