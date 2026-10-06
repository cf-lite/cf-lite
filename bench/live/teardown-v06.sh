#!/usr/bin/env bash
# Delete the five v0.6 bench workers. Needs CLOUDFLARE_API_TOKEN in the environment (export it first).
set -uo pipefail
export PATH=$HOME/cf-lite-live/tool/node_modules/.bin:$PATH
for n in bench-cflite bench-cflite-full bench-vinext bench-next bench-bare; do wrangler delete --name "$n" --force 2>&1 | tail -2; done
