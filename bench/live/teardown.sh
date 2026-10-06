#!/usr/bin/env bash
# Delete the four bench workers (they cost requests). Needs CLOUDFLARE_API_TOKEN in the environment.
set -uo pipefail
export PATH=$HOME/cf-lite-live/tool/node_modules/.bin:$PATH
for n in bench-cflite bench-vinext bench-next bench-bare; do
  wrangler delete --name "$n" --force 2>&1 | tail -2
done
