#!/usr/bin/env python3
"""Reads ../results-live/*.jsonl, prints markdown tables (used to build RESULTS-live.md)."""
import json, glob, os, sys, statistics as st, collections
PFX = sys.argv[1] if len(sys.argv) > 1 else "warm2"
D = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "results-live")
VS = ["bare", "cflite", "vinext", "next"]; RS = ["redirect", "api", "content"]
def pct(a, p): a = sorted(a); return a[min(len(a) - 1, int(len(a) * p / 100))]
warm = collections.defaultdict(list); errs = collections.Counter(); colos = collections.defaultdict(collections.Counter); stat = {}
for fn in sorted(glob.glob(D + f"/{PFX}-*.jsonl")):
    for l in open(fn):
        r = json.loads(l)
        if r["phase"] != "measure": continue
        if PFX == "warm2" and r["route"] == "redirect" and r["i"] % 10 == 0: continue  # 1st request on a fresh connection includes TCP+TLS setup (http.client connects lazily) - not a warm TTFB
        k = (r["host"], r["variant"], r["route"])
        if "err" in r: errs[k] += 1; continue
        warm[k].append(r["ttfb_ms"]); colos[r["host"]][r["colo"]] += 1; stat.setdefault(k, set()).add(r["status"])
hosts = sorted({k[0] for k in warm})
print("### Warm TTFB (ms) p50 / p95 / p99, n per cell, keep-alive, c=1\n")
for h in hosts:
    print(f"**{h}** (colos: {dict(colos[h])})\n\n| variant | " + " | ".join(RS) + " |\n|---|---|---|---|")
    for v in VS:
        cells = []
        for r in RS:
            a = warm.get((h, v, r), [])
            s = "/".join(str(x) for x in sorted(stat.get((h, v, r), [])))
            cells.append(f"{pct(a,50):.1f} / {pct(a,95):.1f} / {pct(a,99):.1f} (n={len(a)}, HTTP {s}, err {errs[(h,v,r)]})" if a else "–")
        print(f"| {v} | " + " | ".join(cells) + " |")
    print()
print("### Delta over `bare` control, p50 (ms), per host (network RTT cancels)\n\n| host | variant | redirect | api | content |\n|---|---|---|---|---|")
for h in hosts:
    for v in VS[1:]:
        print(f"| {h} | {v} | " + " | ".join(f"{pct(warm[(h,v,r)],50)-pct(warm[(h,'bare',r)],50):+.1f}" for r in RS) + " |")
# cold
rows = [json.loads(l) for fn in glob.glob(D + "/cold-*.jsonl") for l in open(fn)] if PFX == "warm2" else []
if rows:
    print("\n### Cold start: first api request on a new connection vs immediate 2nd request on same connection (ms TTFB)\n")
    for kind in ("deploy", "idle"):
        print(f"**{kind}** (n probes per variant; first / second / first-second; connect+TLS median)\n\n| variant | n | first median [min..max] | second median | first−second median | colos |\n|---|---|---|---|---|---|")
        for v in VS:
            rs = [r for r in rows if r["variant"] == v and r["tag"].startswith(kind)]
            if not rs: continue
            f = [r["reqs"][0]["ttfb_ms"] for r in rs]; s = [r["reqs"][1]["ttfb_ms"] for r in rs]; d = [a - b for a, b in zip(f, s)]
            c = collections.Counter(r["reqs"][0]["colo"] for r in rs)
            print(f"| {v} | {len(rs)} | {st.median(f):.0f} [{min(f):.0f}..{max(f):.0f}] | {st.median(s):.0f} | {st.median(d):+.0f} | {dict(c)} |")
        print()
    print("Raw per-probe first-request TTFB (ms):\n")
    for kind in ("deploy", "idle"):
        for v in VS:
            rs = sorted([r for r in rows if r["variant"] == v and r["tag"].startswith(kind)], key=lambda r: r["t"])
            print(f"- {kind}/{v}: " + ", ".join(f"{r['reqs'][0]['ttfb_ms']:.0f}/{r['reqs'][1]['ttfb_ms']:.0f}" for r in rs))

if PFX == "warm2" and os.path.exists(D + "/cpu-analytics-raw.json"):
    rows = json.load(open(D + "/cpu-analytics-raw.json"))["data"]["viewer"]["accounts"][0]["workersInvocationsAdaptive"]
    sch = {x["minute"]: x for x in json.load(open(D + "/cpu-schedule.json"))}
    print("\n### Worker CPU time per request (Workers analytics GraphQL, one minute-aligned burst of 200 requests per cell, from the probing client)\n")
    print("| variant | route | Worker invocations / 200 | CPU p50 (ms) | CPU p99 (ms) | wall p50 (ms) |\n|---|---|---|---|---|---|")
    seen = {}
    for r in rows:
        x = sch.get(r["dimensions"]["datetimeMinute"])
        if x: seen[(x["variant"], x["route"])] = r
    for v in VS:
        for rt in RS:
            r = seen.get((v, rt))
            if r: q = r["quantiles"]; print(f"| {v} | {rt} | {r['sum']['requests']} | {q['cpuTimeP50']/1000:.2f} | {q['cpuTimeP99']/1000:.2f} | {q['wallTimeP50']/1000:.2f} |")
            else: print(f"| {v} | {rt} | 0 (no Worker invocation row) | – | – | – |")
