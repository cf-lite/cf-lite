#!/usr/bin/env bash
# Re-create the four workers (bench-cflite/-vinext/-next/-bare on <account>.workers.dev) from builds made on the build host.
#   1. bash build-remote.sh on the build host (scp it to ~/cf-lite-bench/bench/; work dirs come from bench/run.sh / measure.mjs, which install deps)
#   2. rsync the outputs to ~/cf-lite-live/{cf-lite/dist,vinext/{dist,.cloudflare},next-opennext/{.open-next,wrangler.jsonc},bare-wrangler/dist}
#      (vinext also needs cloudflare.config.ts + package.json copied in and node_modules -> ~/cf-lite-live/tool/node_modules symlink)
#   3. ~/cf-lite-live/tool = `npm i wrangler@^4.144 cf@1.0.0-beta.5`
# The first cold-run.sh `dep` function has the exact deploy commands; this runs them once.
set -euo pipefail
L=~/cf-lite-live; export PATH=$L/tool/node_modules/.bin:$PATH
cf-deploy $L/cf-lite/dist/bench_cf_lite -- --name bench-cflite
cf-deploy $L/bare-wrangler/dist/bench_bare_worker -- --name bench-bare
cf-deploy $L/next-opennext -- --name bench-next
cf-deploy2 $L/vinext deploy --prebuilt
