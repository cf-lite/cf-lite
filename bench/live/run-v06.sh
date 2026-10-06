#!/usr/bin/env bash
# Probe phase, run from client1 after all five workers are deployed: warm (300 samples/cell), CPU bursts + analytics, cold (fresh deploys).
set -uo pipefail
cd "$(dirname "$0")"; mkdir -p ../results-live
echo "warm start $(date -u +%T)"; python3 warm-v06.py client1 ../results-live/v06-warm-client1.jsonl 300 0.05 10; echo "warm done $(date -u +%T)"
S=$(date -u +%Y-%m-%dT%H:%M:00Z)
python3 cpu-v06.py 150; E=$(date -u -d '+2 min' +%Y-%m-%dT%H:%M:00Z)
sleep 90
./cpu-analytics-v06.sh "$S" "$E" > ../results-live/v06-cpu-analytics-raw.json; echo "cpu done $(date -u +%T)"
./cold-run-v06.sh; echo ALL DONE
