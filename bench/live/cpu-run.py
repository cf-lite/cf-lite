#!/usr/bin/env python3
"""Per-route Worker CPU time: for each (variant, route) send a burst of BURST sequential requests that starts at a
minute boundary and stays inside that minute, so the analytics API (datetimeMinute dimension) can attribute CPU quantiles
to exactly one (variant, route). Writes the schedule (minute -> variant/route/n/ok) to ../results-live/cpu-schedule.json."""
import http.client, json, time, ssl, os, sys, datetime
BURST = int(sys.argv[1]) if len(sys.argv) > 1 else 200
V = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "variants.json")))
ctx = ssl.create_default_context(); sched = []
for v in V:
    for route in ("redirect", "api", "content"):
        now = time.time(); nxt = (int(now // 60) + 1) * 60
        time.sleep(max(0, nxt - now) + 0.5)
        c = http.client.HTTPSConnection(V[v]["host"], timeout=20, context=ctx); ok = 0; t0 = time.time(); n = 0
        while n < BURST and time.time() - t0 < 50:
            c.request("GET", V[v][route], headers={"user-agent": "cflite-bench/1"}); r = c.getresponse(); r.read(); ok += r.status < 400; n += 1; time.sleep(0.1)
        minute = datetime.datetime.fromtimestamp(nxt, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:00Z")
        sched.append({"minute": minute, "variant": v, "route": route, "sent": n, "ok": ok}); print(sched[-1], flush=True)
json.dump(sched, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "results-live", "cpu-schedule.json"), "w"), indent=1)
