#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")"; mkdir -p ../results-live
echo "warm start $(date -u +%T)"; python3 warm-v03.py client1 ../results-live/v03-warm-client1.jsonl 300 0.05 10; echo "warm done $(date -u +%T)"
S=$(date -u +%Y-%m-%dT%H:%M:00Z)
python3 cpu-v03.py 150; E=$(date -u -d '+2 min' +%Y-%m-%dT%H:%M:00Z)
sleep 90
./cpu-analytics-v03.sh "$S" "$E" > ../results-live/v03-cpu-analytics-raw.json; echo "cpu done $(date -u +%T)"
./cold-run-v03.sh; echo ALL DONE
