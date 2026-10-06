#!/usr/bin/env python3
"""RSC live bench (RESULTS-rsc-live.md): the same page (list + client island + slow part, `?ms=N`) on three temporary workers.dev Workers.
  warm  <out.jsonl> [N=150]   c=1 keep-alive, targets x ms interleaved per round, reconnect every 10 rounds (first request of a connection dropped by analyze)
  cpu   <out.json> [BURST=150] one minute-aligned burst per (target, ms): schedule for the Workers GraphQL analytics (cpu-analytics-rsc.sh)
  cold  <out.jsonl> <tag> [target ...]   NEW connection, first request, immediate second (warm reference)
  size  <out.json>             client JS the page references (gzip) + HTML bytes
usage: rsc-live.py <cmd> ..."""
import http.client, json, sys, time, ssl, datetime, gzip, re, urllib.request
T = {  # name -> (host, path)
  "cflite-rsc":  ("tmp-rsclive-lite.ACCOUNT.workers.dev", "/rsc"),
  "cflite-ssr":  ("tmp-rsclive-ssr.ACCOUNT.workers.dev", "/ssr"),
  "vinext-rsc":  ("tmp-rsclive-vinext.ACCOUNT.workers.dev", "/rsc"),
}
MS = (0, 150, 400)
ctx = ssl.create_default_context(); conns = {}
H = {"user-agent": "cflite-rsc-bench/1", "accept-encoding": "identity"}
def req(t, ms):
    host, path = T[t]
    if conns.get(t) is None: conns[t] = http.client.HTTPSConnection(host, timeout=30, context=ctx)
    c = conns[t]; t0 = time.perf_counter()
    try:
        c.request("GET", f"{path}?ms={ms}", headers=H); r = c.getresponse(); t1 = time.perf_counter(); body = r.read(); t2 = time.perf_counter()
    except Exception as e:
        conns[t] = None; return {"err": repr(e)}
    return {"status": r.status, "ttfb_ms": (t1 - t0) * 1e3, "total_ms": (t2 - t0) * 1e3, "bytes": len(body), "colo": (r.getheader("cf-ray") or "").rsplit("-", 1)[-1]}
cmd = sys.argv[1]
if cmd == "warm":
    out = sys.argv[2]; N = int(sys.argv[3]) if len(sys.argv) > 3 else 150
    with open(out, "w") as f:
        for phase, n in (("warmup", 5), ("measure", N)):
            for i in range(n):
                if phase == "measure" and i % 10 == 0:
                    for c in conns.values():
                        if c: c.close()
                    conns.clear()
                for ms in MS:
                    for t in T:
                        rec = req(t, ms); rec.update(target=t, ms=ms, phase=phase, i=i, t=time.time()); f.write(json.dumps(rec) + "\n"); time.sleep(0.05)
        f.flush()
elif cmd == "cpu":
    out = sys.argv[2]; BURST = int(sys.argv[3]) if len(sys.argv) > 3 else 150; sched = []
    for ms in (0, 150):
        for t, (host, path) in T.items():
            now = time.time(); nxt = (int(now // 60) + 1) * 60; time.sleep(max(0, nxt - now) + 0.5)
            c = http.client.HTTPSConnection(host, timeout=30, context=ctx); ok = n = 0; t0 = time.time()
            while n < BURST and time.time() - t0 < 50:
                c.request("GET", f"{path}?ms={ms}", headers={"user-agent": H["user-agent"]}); r = c.getresponse(); r.read(); ok += r.status == 200; n += 1; time.sleep(0.05)
            minute = datetime.datetime.fromtimestamp(nxt, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:00Z")
            sched.append({"minute": minute, "target": t, "ms": ms, "sent": n, "ok": ok}); print(sched[-1], flush=True)
    json.dump(sched, open(out, "w"), indent=1)
elif cmd == "cold":
    out, tag = sys.argv[2:4]; only = sys.argv[4:] or list(T)
    with open(out, "a") as f:
        for t in only:
            host, path = T[t]; t0 = time.perf_counter(); c = http.client.HTTPSConnection(host, timeout=40, context=ctx); c.connect(); tc = time.perf_counter() - t0; res = []
            for _ in range(3):
                t1 = time.perf_counter(); c.request("GET", f"{path}?ms=0", headers=H); r = c.getresponse(); t2 = time.perf_counter(); r.read()
                res.append({"status": r.status, "ttfb_ms": (t2 - t1) * 1e3, "colo": (r.getheader("cf-ray") or "").rsplit("-", 1)[-1]})
            c.close(); rec = {"target": t, "tag": tag, "connect_tls_ms": tc * 1e3, "reqs": res, "t": time.time()}; f.write(json.dumps(rec) + "\n"); f.flush()
            print(tag, t, round(res[0]["ttfb_ms"], 1), "then", round(res[1]["ttfb_ms"], 1), flush=True)
elif cmd == "size":
    out = {}
    for t, (host, path) in T.items():
        base = f"https://{host}"; html = urllib.request.urlopen(urllib.request.Request(f"{base}{path}?ms=0", headers={"user-agent": H["user-agent"]})).read().decode()
        srcs = set(re.findall(r'<script[^>]*\ssrc="([^"]+)"', html)) | set(re.findall(r'<link[^>]*rel="modulepreload"[^>]*href="([^"]+)"', html))
        raw = gz = 0
        for s in srcs:
            b = urllib.request.urlopen(urllib.request.Request(urllib.request.urljoin(base, s), headers={"user-agent": H["user-agent"]})).read(); raw += len(b); gz += len(gzip.compress(b, 9))
        inl = "".join(re.findall(r'<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)</script>', html))
        out[t] = {"externalFiles": len(srcs), "externalRaw": raw, "externalGzip": gz, "inlineGzip": len(gzip.compress(inl.encode(), 9)), "htmlBytes": len(html.encode())}
    json.dump(out, open(sys.argv[2], "w"), indent=1); print(json.dumps(out))
