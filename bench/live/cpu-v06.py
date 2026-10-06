#!/usr/bin/env python3
"""v0.6 per-route Worker CPU: one minute-aligned burst of BURST requests per (variant, route), schedule -> ../results-live/v06-cpu-schedule.json."""
import http.client, json, time, ssl, os, sys, datetime
BURST = int(sys.argv[1]) if len(sys.argv) > 1 else 150
here = os.path.dirname(os.path.abspath(__file__))
V = json.load(open(os.path.join(here, "variants-v06.json"))); ctx = ssl.create_default_context(); sched = []
for v in V:
    for route in ("redirect", "api", "content", "session"):
        if route not in V[v]: continue
        now = time.time(); nxt = (int(now // 60) + 1) * 60; time.sleep(max(0, nxt - now) + 0.5)
        c = http.client.HTTPSConnection(V[v]["host"], timeout=20, context=ctx); ok = 0; t0 = time.time(); n = 0
        while n < BURST and time.time() - t0 < 50:
            c.request("GET", V[v][route], headers={"user-agent": "cflite-bench/1"}); r = c.getresponse(); r.read(); ok += r.status < 400; n += 1; time.sleep(0.1)
        minute = datetime.datetime.fromtimestamp(nxt, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:00Z")
        sched.append({"minute": minute, "variant": v, "route": route, "sent": n, "ok": ok}); print(sched[-1], flush=True)
json.dump(sched, open(os.path.join(here, "..", "results-live", "v06-cpu-schedule.json"), "w"), indent=1)
