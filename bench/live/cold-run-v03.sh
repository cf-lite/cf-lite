#!/usr/bin/env bash
# v0.3 cold-start (deploy phase): 5 x per variant `wrangler deploy` of the already-built output (new version, --message), then probe immediately.
# Run AFTER `cf-lite deploy` of each example (so dist/ + .wrangler/deploy exist) and after the bare control is deployed.
set -uo pipefail
cd "$(dirname "$0")"; OUT=../results-live/v03-cold-client1.jsonl; R=$(cd ../.. && pwd); TOOL=~/cf-lite-live/tool/node_modules/.bin
dep(){ case $1 in
  bare)   PATH=$TOOL:$PATH cf-deploy ~/cf-lite-live/bare-wrangler/dist/bench_bare_worker -- --name bench-bare --message "cold-$2" ;;
  demo)   cf-deploy $R/examples/demo -- --message "cold-$2" ;;
  react)  cf-deploy $R/examples/site -- --name cflite-site-react --message "cold-$2" ;;
  preact) cf-deploy $R/examples/site-preact -- --name cflite-site-preact --message "cold-$2" ;;
  vue)    cf-deploy $R/examples/site-vue -- --name cflite-site-vue --message "cold-$2" ;;
  svelte) cf-deploy $R/examples/site-svelte -- --name cflite-site-svelte --message "cold-$2" ;;
esac; }
for n in 1 2 3 4 5; do for v in bare demo react preact vue svelte; do
  dep $v $n >/tmp/dep03-$v-$n.log 2>&1 || echo "deploy FAILED $v $n"
  python3 cold-v03.py client1 $OUT deploy-$n $v
done; done
echo "deploy phase done $(date -u +%T)"
