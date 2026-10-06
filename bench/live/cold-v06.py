#!/usr/bin/env python3
"""v0.6 cold-start probe: NEW connection, first /api/hello, immediate 2nd /api/hello (warm reference), then ssr + static.
usage: cold-v03.py <label> <out.jsonl> <tag> [variant ...]"""
import http.client, json, sys, time, ssl, os
label, out, tag = sys.argv[1:4]
V = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "variants-v06.json")))
only = sys.argv[4:] or list(V); ctx = ssl.create_default_context()
def probe(v):
    t = time.perf_counter(); c = http.client.HTTPSConnection(V[v]["host"], timeout=30, context=ctx); c.connect(); tc = time.perf_counter() - t
    res = []
    for route in ("api", "api", "content"):
        t0 = time.perf_counter()
        c.request("GET", V[v][route], headers={"user-agent": "cflite-bench/1", "accept-encoding": "identity"})
        r = c.getresponse(); t1 = time.perf_counter(); r.read()
        res.append({"route": route, "status": r.status, "ttfb_ms": (t1 - t0) * 1e3, "colo": (r.getheader("cf-ray") or "").rsplit("-", 1)[-1]})
    c.close(); return {"connect_tls_ms": tc * 1e3, "reqs": res}
with open(out, "a") as f:
    for v in only:
        rec = probe(v); rec.update(host=label, variant=v, tag=tag, t=time.time())
        f.write(json.dumps(rec) + "\n"); f.flush()
        print(label, tag, v, round(rec["reqs"][0]["ttfb_ms"], 1), "then", round(rec["reqs"][1]["ttfb_ms"], 1), flush=True)
