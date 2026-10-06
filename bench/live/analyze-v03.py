#!/usr/bin/env python3
"""Reads ../results-live/v03-*.{jsonl,json}, prints markdown for RESULTS-live.md (v0.3 section)."""
import json, glob, os, statistics as st, collections
D = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "results-live")
VS = ["bare", "demo", "react", "preact", "vue", "svelte"]; RS = ["redirect", "api", "static", "ssr"]
def pct(a, p): a = sorted(a); return a[min(len(a) - 1, int(len(a) * p / 100))]
warm = collections.defaultdict(list); errs = collections.Counter(); colos = collections.Counter(); stat = {}
for fn in sorted(glob.glob(D + "/v03-warm-*.jsonl")):
    for l in open(fn):
        r = json.loads(l)
        if r["phase"] != "measure": continue
        if r["i"] % 10 == 0 and r["route"] == (("redirect" if r["variant"] in ("bare", "demo") else "api")): continue  # 1st request on a fresh connection includes TCP+TLS
        k = (r["variant"], r["route"])
        if "err" in r: errs[k] += 1; continue
        warm[k].append(r["ttfb_ms"]); colos[r["colo"]] += 1; stat.setdefault(k, set()).add(r["status"])
print(f"### Warm TTFB (ms), probing client, p50 / p95 / p99 (colos: {dict(colos)})\n\n| variant | " + " | ".join(RS) + " |\n|---|---|---|---|---|")
for v in VS:
    c = []
    for r in RS:
        a = warm.get((v, r), [])
        c.append(f"{pct(a,50):.1f} / {pct(a,95):.1f} / {pct(a,99):.1f} (n={len(a)}, HTTP {'/'.join(map(str, sorted(stat[(v,r)])))}, err {errs[(v,r)]})" if a else "–")
    print(f"| {v} | " + " | ".join(c) + " |")
print("\n### Delta over `bare` control, p50 (ms)\n\n| variant | " + " | ".join(RS) + " |\n|---|---|---|---|---|")
for v in VS[1:]:
    print(f"| {v} | " + " | ".join(f"{pct(warm[(v,r)],50)-pct(warm[('bare',r)],50):+.1f}" if warm.get((v, r)) else "–" for r in RS) + " |")
rows = [json.loads(l) for fn in glob.glob(D + "/v03-cold-*.jsonl") for l in open(fn)]
if rows:
    print("\n### Cold start after fresh deploy: first `/api/hello` on a new connection vs immediate 2nd request (ms TTFB)\n\n| variant | n | first median [min..max] | second median | first-second median | colos |\n|---|---|---|---|---|---|")
    for v in VS:
        rs = [r for r in rows if r["variant"] == v and r["tag"].startswith("deploy")]
        if not rs: continue
        f = [r["reqs"][0]["ttfb_ms"] for r in rs]; s = [r["reqs"][1]["ttfb_ms"] for r in rs]; d = [a - b for a, b in zip(f, s)]
        print(f"| {v} | {len(rs)} | {st.median(f):.0f} [{min(f):.0f}..{max(f):.0f}] | {st.median(s):.0f} | {st.median(d):+.0f} | {dict(collections.Counter(r['reqs'][0]['colo'] for r in rs))} |")
    print("\nFirst-request TTFB / second-request TTFB per probe (ms), in order:\n")
    for v in VS:
        rs = sorted([r for r in rows if r["variant"] == v], key=lambda r: r["t"])
        print(f"- {v}: " + ", ".join(f"{r['reqs'][0]['ttfb_ms']:.0f}/{r['reqs'][1]['ttfb_ms']:.0f}" for r in rs))
if os.path.exists(D + "/v03-cpu-analytics-raw.json"):
    rows = json.load(open(D + "/v03-cpu-analytics-raw.json"))["data"]["viewer"]["accounts"][0]["workersInvocationsAdaptive"]
    sch = json.load(open(D + "/v03-cpu-schedule.json")); byminute = {x["minute"]: x for x in sch}; seen = {}
    for r in rows:
        x = byminute.get(r["dimensions"]["datetimeMinute"])
        if x: seen[(x["variant"], x["route"])] = (r, x)
    print("\n### Worker CPU time per request (Workers analytics, one minute-aligned burst per cell from the probing client)\n\n| variant | route | requests sent | Worker invocations | CPU p50 (ms) | CPU p99 (ms) | wall p50 (ms) |\n|---|---|---|---|---|---|---|")
    for v in VS:
        for rt in RS:
            x = next((s for s in sch if s["variant"] == v and s["route"] == rt), None)
            if not x: continue
            if (v, rt) in seen:
                r = seen[(v, rt)][0]; q = r["quantiles"]
                print(f"| {v} | {rt} | {x['sent']} | {r['sum']['requests']} | {q['cpuTimeP50']/1000:.2f} | {q['cpuTimeP99']/1000:.2f} | {q['wallTimeP50']/1000:.2f} |")
            else: print(f"| {v} | {rt} | {x['sent']} | 0 (no Worker invocation row) | – | – | – |")
