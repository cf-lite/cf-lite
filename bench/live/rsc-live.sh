#!/usr/bin/env bash
# RSC live bench driver (after the three tmp-rsclive-* workers are deployed). Output -> ../results-live/rsc-live-*.
# Needs: built scratch apps (e2e/.tmp/live/{rsc,ssr}), /tmp/rsclive-vinext (prebuilt), cf-deploy, cf-deploy2.
set -uo pipefail
cd "$(dirname "$0")"; R=$(cd ../.. && pwd); O=../results-live; mkdir -p $O
export PATH=$HOME/cf-lite-live/tool/node_modules/.bin:$PATH
echo "warm start $(date -u +%T)"; python3 rsc-live.py warm $O/rsc-live-warm.jsonl 150; echo "warm done $(date -u +%T)"
S=$(date -u +%Y-%m-%dT%H:%M:00Z)
python3 rsc-live.py cpu $O/rsc-live-cpu-schedule.json 150; E=$(date -u -d '+2 min' +%Y-%m-%dT%H:%M:00Z)
sleep 90
./cpu-analytics-rsc.sh "$S" "$E" > $O/rsc-live-cpu-analytics-raw.json; echo "cpu done $(date -u +%T)"
dep(){ case $1 in
  cflite-rsc) cf-deploy $R/e2e/.tmp/live/rsc -- --message "cold-$2" ;;
  cflite-ssr) cf-deploy $R/e2e/.tmp/live/ssr -- --message "cold-$2" ;;
  vinext-rsc) cf-deploy2 /tmp/rsclive-vinext deploy --prebuilt --message "cold-$2" ;;
esac; }
for n in 1 2 3 4 5; do for v in cflite-rsc vinext-rsc cflite-ssr; do
  dep $v $n >/tmp/rsclive-dep-$v-$n.log 2>&1 || echo "deploy FAILED $v $n"
  python3 rsc-live.py cold $O/rsc-live-cold.jsonl deploy-$n $v
done; done
echo "phase A done $(date -u +%T)"
for n in 1 2 3; do sleep 960; echo "idle round $n $(date -u +%T)"; python3 rsc-live.py cold $O/rsc-live-cold.jsonl idle-$n; done
echo "ALL DONE $(date -u +%T)"
