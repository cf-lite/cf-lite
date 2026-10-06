#!/usr/bin/env bash
# Runs ON the build host inside ~/cf-lite-bench/bench/work (deps already installed by bench/run.sh/measure.mjs).
# Rebuilds the deployable outputs with a hard timeout per build and aborts if 1-min load > 40 (fork-storm guard).
set -uo pipefail
cd ~/cf-lite-bench/bench/work
export NEXT_TELEMETRY_DISABLED=1 CI=1
guard(){ while kill -0 "$1" 2>/dev/null; do l=$(cut -d' ' -f1 /proc/loadavg); if [ "${l%.*}" -gt 40 ]; then echo "LOAD $l > 40, aborting build pid $1"; kill "$1"; return 1; fi; sleep 3; done; }
b(){ name=$1; shift; echo "=== build $name"; ( cd "$name" && rm -rf "${OUT[@]}" && exec timeout -k 10 900 "$@" ) & p=$!; echo "pid $p"; guard $p; wait $p; echo "exit $? load $(cut -d' ' -f1 /proc/loadavg)"; }
OUT=(dist .cf-lite .wrangler); b cf-lite npm run build
OUT=(dist .cloudflare .vite); b vinext npm run build
OUT=(.next .open-next .wrangler); b next-opennext npx opennextjs-cloudflare build
OUT=(dist .wrangler); b bare-wrangler npm run build
