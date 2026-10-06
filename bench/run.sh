#!/usr/bin/env bash
# Reproducible benchmark. Default: run on this machine.
#   bash bench/run.sh                           # local
#   BENCH_HOST=user@idle-box bash bench/run.sh  # rsync the repo to an idle machine over ssh and run there
#   APPS="cf-lite vinext" RUNS=3 BENCH_REQS=3000 bash bench/run.sh
set -euo pipefail
cd "$(dirname "$0")/.."
HOST="${BENCH_HOST:-local}"; APPS="${APPS:-cf-lite cf-lite-wrangler vinext next-opennext bare-vite bare-wrangler cf-lite-ssr cf-lite-ssr-preact}"; RUNS="${RUNS:-3}"
if [ "$HOST" != local ]; then
  ssh "$HOST" 'mkdir -p ~/cf-lite-bench'
  rsync -a --delete --exclude node_modules --exclude dist --exclude .git --exclude .wrangler --exclude '.cf-lite' --exclude bench/work --exclude bench/results ./ "$HOST:~/cf-lite-bench/"
  ssh "$HOST" "cd ~/cf-lite-bench && APPS='$APPS' RUNS=$RUNS BENCH_REQS=${BENCH_REQS:-3000} BENCH_HOST=local bash bench/run.sh"
  mkdir -p bench/results && rsync -a "$HOST:~/cf-lite-bench/bench/results/" bench/results/ && rsync -a "$HOST:~/cf-lite-bench/bench/RESULTS.md" bench/RESULTS.md
  exit 0
fi
[ -d node_modules ] || npm install --no-audit --no-fund >/dev/null
npm run build >/dev/null   # cf-lite package -> dist, needed by `npm pack`
for a in $APPS; do echo "=== $a"; node bench/measure.mjs "$a" --runs "$RUNS" >/dev/null || echo "measure failed: $a"; done
node bench/report.mjs
