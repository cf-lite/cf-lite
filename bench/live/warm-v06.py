#!/usr/bin/env python3
"""v0.6 warm TTFB probe (variants-v06.json). Same method as warm-v03.py: one keep-alive connection per variant, c=1, variants x routes interleaved,
reconnect every RC rounds (first request on a fresh connection is dropped by analyze-v06.py). Routes a variant lacks are skipped.
usage: warm-v06.py <label> <out.jsonl> [N=300] [spacing=0.05] [reconnect_every=10]"""
import http.client, json, sys, time, ssl, os
label, out = sys.argv[1], sys.argv[2]
N = int(sys.argv[3]) if len(sys.argv) > 3 else 300
SP = float(sys.argv[4]) if len(sys.argv) > 4 else 0.05
RC = int(sys.argv[5]) if len(sys.argv) > 5 else 10
V = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "variants-v06.json")))
ROUTES = ("redirect", "api", "content", "session")
ctx = ssl.create_default_context(); conns = {}
def req(v, route):
    if conns.get(v) is None: conns[v] = http.client.HTTPSConnection(V[v]["host"], timeout=20, context=ctx)
    c = conns[v]; t0 = time.perf_counter()
    try:
        c.request("GET", V[v][route], headers={"user-agent": "cflite-bench/1", "accept-encoding": "identity"})
        r = c.getresponse(); t1 = time.perf_counter(); body = r.read(); t2 = time.perf_counter()
    except Exception as e:
        conns[v] = None; return {"err": repr(e)}
    return {"status": r.status, "ttfb_ms": (t1 - t0) * 1e3, "total_ms": (t2 - t0) * 1e3, "bytes": len(body),
            "colo": (r.getheader("cf-ray") or "").rsplit("-", 1)[-1]}
with open(out, "w") as f:
    for phase, n in (("warmup", 10), ("measure", N)):
        for i in range(n):
            if RC and phase == "measure" and i % RC == 0:
                for c in conns.values():
                    if c: c.close()
                conns.clear()
            for v in V:
                for route in ROUTES:
                    if route not in V[v]: continue
                    rec = req(v, route); rec.update(host=label, variant=v, route=route, phase=phase, i=i, t=time.time())
                    f.write(json.dumps(rec) + "\n"); time.sleep(SP)
    f.flush()
