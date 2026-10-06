#!/usr/bin/env bash
# Runs ON the build host in ~/cf-lite-bench after `rsync` of the repo (see rebench.sh / bench/run.sh for the rsync line).
# Builds cf-lite (current main, from `npm pack` tarballs) in two variants - plain (`cf-lite`) and "realistic" (`cf-lite-full`: gate + sessions +
# strict security headers + logging/observability) - plus rebuilds the vinext / Next / bare controls with the same deps as the 0.1.0 live run.
# Every build: `timeout -k 10 900` + load guard (abort that build's PID if 1-min load > 40). Writes build-v06.json (build seconds, Worker gzip/raw).
set -uo pipefail
cd ~/cf-lite-bench
W=bench/work-v06; export NEXT_TELEMETRY_DISABLED=1 CI=1
guard(){ while kill -0 "$1" 2>/dev/null; do l=$(cut -d' ' -f1 /proc/loadavg); if [ "${l%.*}" -gt 40 ]; then echo "LOAD $l > 40, aborting build pid $1" >&2; kill "$1"; return 1; fi; sleep 3; done; }
# timed build: tb <dir> <runs> <out-dirs...> -- <cmd...>  -> appends "secs" lines to $T
tb(){ d=$1; runs=$2; shift 2; outs=(); while [ "$1" != "--" ]; do outs+=("$1"); shift; done; shift
  T=""; for i in $(seq "$runs"); do ( cd "$d" && rm -rf "${outs[@]}" )
    ( cd "$d" && s=$EPOCHREALTIME; timeout -k 10 900 "$@" >.build.log 2>&1; rc=$?; echo "$s $EPOCHREALTIME $rc" >.build.time; exit $rc ) & p=$!; echo "  pid $p" >&2; guard $p; wait $p; rc=$?
    T="$T $(awk '{printf "%.2f", $2-$1}' "$d/.build.time") "; [ $rc -ne 0 ] && { echo "  build FAILED rc=$rc in $d" >&2; tail -20 "$d/.build.log" >&2; break; }
  done; echo "$d build secs:$T load $(cut -d' ' -f1 /proc/loadavg)" >&2; BT="$T"; }
gz(){ python3 - "$1" <<'PY'
import sys,zlib; b=open(sys.argv[1],'rb').read(); print(len(b), len(zlib.compress(b,9)))
PY
}
echo "== packages build + pack"
npm install --no-audit --no-fund >/dev/null 2>&1; npm run build >/dev/null 2>&1 || { echo "package build failed"; exit 1; }
rm -rf $W; mkdir -p $W
npm pack --pack-destination $W -w cf-lite -w @cf-lite/react --silent >/dev/null
TGZ=$(ls $W/*.tgz | sed "s#^#$PWD/#" | tr '\n' ' '); echo "tarballs: $TGZ"
SECRET=$(head -c 32 /dev/urandom | base64 | tr -d '=+/')   # throwaway, bench-only, never printed
for a in cf-lite cf-lite-full; do
  cp -r bench/apps/$a $W/$a; printf '/go/github  https://github.com/example  302\n' > $W/$a/public/_redirects
  sed -i "s/__BENCH_SESSION_SECRET__/$SECRET/" $W/$a/wrangler.jsonc
  ( cd $W/$a && npm install --no-audit --no-fund $TGZ >/dev/null 2>&1 && npm install --no-audit --no-fund >/dev/null 2>&1 ) || echo "install failed $a"
done
echo '{}' > $W/build-v06.json
rec(){ python3 - "$W/build-v06.json" "$1" "$2" "$3" "$4" <<'PY'
import sys,json; f,name,secs,raw,gz=sys.argv[1:6]; d=json.load(open(f))
d[name]={"buildSeconds":[float(x) for x in secs.split()],"workerRaw":int(raw),"workerGzip":int(gz)}; json.dump(d,open(f,"w"),indent=1)
PY
}
for a in cf-lite cf-lite-full; do echo "== build $a"; tb $W/$a 3 dist .cf-lite .wrangler -- npm run build; wd=$(ls $W/$a/dist | grep -v client | head -1); read raw g < <(gz $W/$a/dist/$wd/index.js); rec $a "$BT" $raw $g; done
cd ~/cf-lite-bench/bench/work
echo "== controls (existing deps)"
tb bare-wrangler 3 dist .wrangler -- npm run build; wd=$(ls bare-wrangler/dist | grep -v client | head -1); read raw g < <(gz bare-wrangler/dist/$wd/index.js); cd ~/cf-lite-bench; rec bare "$BT" $raw $g; cd bench/work
tb vinext 1 dist .cloudflare .vite -- npm run build; S="$BT"
tb next-opennext 1 .next .open-next .wrangler -- npx opennextjs-cloudflare build
cd ~/cf-lite-bench; python3 - "$W/build-v06.json" "$S" "$BT" <<'PY'
import sys,json; f,v,n=sys.argv[1:4]; d=json.load(open(f)); d["vinext"]={"buildSeconds":[float(x) for x in v.split()]}; d["next"]={"buildSeconds":[float(x) for x in n.split()]}; json.dump(d,open(f,"w"),indent=1)
PY
cat $W/build-v06.json; echo BUILD-DONE
