#!/usr/bin/env python3
"""Tables for RESULTS-rsc-live.md from ../results-live/rsc-live-*. usage: analyze-rsc-live.py"""
import json, os, statistics as st, collections
O = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "results-live")
def q(a, p): s = sorted(a); return s[min(len(s) - 1, int(len(s) * p))]
rows = [json.loads(l) for l in open(f"{O}/rsc-live-warm.jsonl")]
m = [r for r in rows if r["phase"] == "measure" and "err" not in r and r["status"] == 200]
errs = sum(1 for r in rows if r["phase"] == "measure" and ("err" in r or r.get("status") != 200))
# drop the first request of each connection (every 10th round, per target)
seen = set(); keep = []
for r in m:
    k = (r["target"], r["i"] // 10)
    if k not in seen: seen.add(k); continue
    keep.append(r)
print(f"warm: {len(m)} ok, {errs} errors, {len(keep)} kept after dropping connection-first requests; colos: {dict(collections.Counter(r['colo'] for r in keep))}")
print("\n| ms | target | n | TTFB p50 / p95 / p99 | total p50 / p95 | bytes |\n|---|---|---|---|---|---|")
for ms in (0, 150, 400):
    for t in ("cflite-ssr", "cflite-rsc", "vinext-rsc"):
        a = [r for r in keep if r["target"] == t and r["ms"] == ms]
        if not a: continue
        f = lambda k, p: round(q([r[k] for r in a], p), 1)
        print(f"| {ms} | {t} | {len(a)} | {f('ttfb_ms',.5)} / {f('ttfb_ms',.95)} / {f('ttfb_ms',.99)} | {f('total_ms',.5)} / {f('total_ms',.95)} | {a[0]['bytes']} |")
print("\nCPU (Workers analytics, per-minute burst, microseconds -> ms):")
sched = json.load(open(f"{O}/rsc-live-cpu-schedule.json")); raw = json.load(open(f"{O}/rsc-live-cpu-analytics-raw.json"))
try: recs = raw["data"]["viewer"]["accounts"][0]["workersInvocationsAdaptive"]
except Exception: recs = []; print("analytics unreadable:", str(raw)[:300])
by = collections.defaultdict(list)
for r in recs: by[r["dimensions"]["datetimeMinute"]].append(r) # the API reports scriptName __unknown__: bursts are told apart by their own minute (schedule)
name = {"cflite-rsc": "tmp-rsclive-lite", "cflite-ssr": "tmp-rsclive-ssr", "vinext-rsc": "tmp-rsclive-vinext"}
print("| ms | target | sent | analytics requests | CPU p50 | p75 | p99 | wall p50 |\n|---|---|---|---|---|---|---|---|")
for s in sched:
    rs = [r for r in by.get(s["minute"], []) if r["dimensions"]["status"] == "success"]
    if not rs: print(f"| {s['ms']} | {s['target']} | {s['sent']} | - | n/a | | | |"); continue
    r = max(rs, key=lambda x: x["sum"]["requests"]); qq = r["quantiles"]
    print(f"| {s['ms']} | {s['target']} | {s['sent']} | {r['sum']['requests']} | {qq['cpuTimeP50']/1000:.2f} ms | {qq['cpuTimeP75']/1000:.2f} | {qq['cpuTimeP99']/1000:.2f} | {qq['wallTimeP50']/1000:.1f} ms |")
print("\nCold (first request on a new connection minus the immediate second request; TTFB):")
c = [json.loads(l) for l in open(f"{O}/rsc-live-cold.jsonl")]
print("| phase | target | n | first p50 | second p50 | cold cost p50 (first - second) | cold cost min..max |\n|---|---|---|---|---|---|---|")
for ph in ("deploy", "idle"):
    for t in ("cflite-ssr", "cflite-rsc", "vinext-rsc"):
        a = [r for r in c if r["tag"].startswith(ph) and r["target"] == t and r["reqs"][0]["status"] == 200]
        if not a: continue
        d = [r["reqs"][0]["ttfb_ms"] - r["reqs"][1]["ttfb_ms"] for r in a]
        print(f"| {ph} | {t} | {len(a)} | {st.median([r['reqs'][0]['ttfb_ms'] for r in a]):.0f} | {st.median([r['reqs'][1]['ttfb_ms'] for r in a]):.0f} | {st.median(d):.0f} ms | {min(d):.0f}..{max(d):.0f} |")
