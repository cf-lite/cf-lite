#!/usr/bin/env bash
# Run from the probing client after the warm runs finished. Phase A: fresh deploy x5 per variant, first request right after deploy.
# Phase B: 5 idle rounds, >=16 min of zero traffic before each (all four variants probed back-to-back at the end).
# Needs: ~/cf-lite-live/{cf-lite,bare-wrangler,next-opennext,vinext,tool} (build outputs + wrangler/cf), cf-deploy, cf-deploy2.
set -uo pipefail
cd "$(dirname "$0")"; OUT=../results-live/cold-client1.jsonl; L=~/cf-lite-live
export PATH=$L/tool/node_modules/.bin:$PATH
dep(){ case $1 in
  cflite) cf-deploy $L/cf-lite/dist/bench_cf_lite -- --name bench-cflite --message "cold-$2" ;;
  bare)   cf-deploy $L/bare-wrangler/dist/bench_bare_worker -- --name bench-bare --message "cold-$2" ;;
  next)   cf-deploy $L/next-opennext -- --name bench-next --message "cold-$2" ;;
  vinext) cf-deploy2 $L/vinext deploy --prebuilt --message "cold-$2" ;;
esac; }
for n in 1 2 3 4 5; do for v in cflite vinext next bare; do
  dep $v $n >/tmp/dep-$v-$n.log 2>&1 || echo "deploy FAILED $v $n"
  grep -ao "Version ID: [0-9a-f-]*" /tmp/dep-$v-$n.log | tail -1 | sed "s/^/$v $n /"
  python3 cold.py client1 $OUT deploy-$n $v
done; done
echo "phase A done $(date -u +%T)"
for n in 1 2 3 4 5; do sleep 960; echo "idle round $n $(date -u +%T)"; python3 cold.py client1 $OUT idle-$n; done
echo "phase B done $(date -u +%T)"
