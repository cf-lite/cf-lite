#!/usr/bin/env python3
"""Warm TTFB probe. One persistent HTTPS connection per variant, c=1, variants/routes interleaved round-robin
(so network drift hits all variants alike), SPACING s between requests. TTFB = send -> response headers (http.client
getresponse()); total = until body fully read. Writes JSONL (one record per request).
usage: warm.py <label> <out.jsonl> [N=300] [spacing=0.05] [reconnect_every=0]
reconnect_every>0: drop and re-establish every variant connection each K measured rounds (averages over per-connection edge-server/path placement)."""
import http.client, json, sys, time, ssl, os
label, out = sys.argv[1], sys.argv[2]
N = int(sys.argv[3]) if len(sys.argv) > 3 else 300
SP = float(sys.argv[4]) if len(sys.argv) > 4 else 0.05
RC = int(sys.argv[5]) if len(sys.argv) > 5 else 0
V = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "variants.json")))
ctx = ssl.create_default_context()
conns = {}
def conn(v):
    if v not in conns or conns[v] is None:
        conns[v] = http.client.HTTPSConnection(V[v]["host"], timeout=20, context=ctx)
    return conns[v]
def req(v, route):
    c = conn(v); t0 = time.perf_counter()
    try:
        c.request("GET", V[v][route], headers={"user-agent": "cflite-bench/1", "accept-encoding": "identity"})
        r = c.getresponse(); t1 = time.perf_counter(); body = r.read(); t2 = time.perf_counter()
    except Exception as e:
        conns[v] = None
        return {"err": repr(e)}
    ray = r.getheader("cf-ray") or ""
    return {"status": r.status, "ttfb_ms": (t1 - t0) * 1e3, "total_ms": (t2 - t0) * 1e3, "bytes": len(body),
            "colo": ray.rsplit("-", 1)[-1], "cache": r.getheader("cf-cache-status")}
with open(out, "w") as f:
    for phase, n in (("warmup", 10), ("measure", N)):
        for i in range(n):
            if RC and phase == "measure" and i % RC == 0:
                for c in conns.values():
                    if c: c.close()
                conns.clear()
            for v in V:
                for route in ("redirect", "api", "content"):
                    rec = req(v, route)
                    rec.update(host=label, variant=v, route=route, phase=phase, i=i, t=time.time())
                    f.write(json.dumps(rec) + "\n"); time.sleep(SP)
    f.flush()
