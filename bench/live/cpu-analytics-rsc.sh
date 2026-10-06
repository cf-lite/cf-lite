#!/usr/bin/env bash
# Workers CPU per request (workersInvocationsAdaptive) for the three temporary rsc-live workers. usage: cpu-analytics-rsc.sh <since-ISO> <until-ISO> (CLOUDFLARE_API_TOKEN from the environment)
set -euo pipefail
ACC=5428747acff6eee82f9d2fba7162ba22
Q=$(python3 - "$1" "$2" "$ACC" <<'PY'
import json,sys
s,u,a=sys.argv[1:4]
q='''query($a:String!,$s:Time!,$u:Time!){viewer{accounts(filter:{accountTag:$a}){
 workersInvocationsAdaptive(limit:200,filter:{datetime_geq:$s,datetime_leq:$u,scriptName_in:["tmp-rsclive-lite","tmp-rsclive-ssr","tmp-rsclive-vinext"]}){
  dimensions{datetimeMinute scriptName status} sum{requests errors subrequests} quantiles{cpuTimeP50 cpuTimeP75 cpuTimeP99 cpuTimeP999 wallTimeP50 wallTimeP99}}}}}'''
print(json.dumps({"query":q,"variables":{"a":a,"s":s,"u":u}}))
PY
)
bash -c 'curl -s -m30 https://api.cloudflare.com/client/v4/graphql -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "content-type: application/json" --data "$1"' _ "$Q"
