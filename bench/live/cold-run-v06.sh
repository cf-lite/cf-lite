#!/usr/bin/env bash
# v0.6 cold start (fresh-deploy phase): 5 x per variant redeploy of the built output (new version, --message), probe immediately from this host.
set -uo pipefail
cd "$(dirname "$0")"; OUT=../results-live/v06-cold-client1.jsonl
for n in 1 2 3 4 5; do for v in bare cflite full vinext next; do
  ./deploy-v06.sh $v "cold-$n" >/tmp/dep06-$v-$n.log 2>&1 || echo "deploy FAILED $v $n"
  python3 cold-v06.py client1 $OUT deploy-$n $v
done; done
echo "deploy phase done $(date -u +%T)"
