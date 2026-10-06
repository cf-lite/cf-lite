import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import { testApp, runScheduled, fakeQueue, fakeWorkflow } from "@cf-lite/testing";
import worker from "../server/worker";

describe("api", () => {
  const app = testApp();

  it("GET /api/hello", async () => {
    const res = await app.fetch("/api/hello?name=cf");
    expect(res.status).toBe(200);
    expect((await res.json() as { message: string }).message).toBe("hello cf");
  });

  it("purge endpoint is gated by the bearer token", async () => {
    const body = JSON.stringify({ tags: ["posts"] });
    const init = { method: "POST", body, headers: { "content-type": "application/json" } };
    expect((await app.fetch("/api/cache/purge", init)).status).toBe(401);
    expect((await app.fetch("/api/cache/purge", { ...init, headers: { ...init.headers, authorization: "Bearer nope" } })).status).toBe(401);
    const ok = await app.with({ authorization: "Bearer test-token" }).fetch("/api/cache/purge", init);
    expect(ok.status).toBe(200);
  });

  it("purge endpoint answers 503 when no token is configured", async () => {
    const bare = testApp({ worker, env: { CACHE_PURGE_TOKEN: undefined } });
    const res = await bare.fetch("/api/cache/purge", { method: "POST", body: "{}" });
    expect(res.status).toBe(503);
  });

  it("cron: scheduled() runs with the given cron + frozen time", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runScheduled(worker, { cron: "*/30 * * * *", time: new Date("2026-01-02T03:04:05Z") });
    expect(log).toHaveBeenCalledWith("cron fired", "*/30 * * * *", "2026-01-02T03:04:05.000Z");
    log.mockRestore();
  });
});

describe("isolation", () => {
  it("test A writes KV + D1", async () => {
    await env.CF_CACHE_TAGS.put("leak", "1");
    await env.CF_CACHE_DB.exec("CREATE TABLE IF NOT EXISTS t (x)");
    await env.CF_CACHE_DB.exec("INSERT INTO t VALUES (1)");
    expect(await env.CF_CACHE_TAGS.get("leak")).toBe("1");
  });
  it("test B sees neither", async () => {
    expect(await env.CF_CACHE_TAGS.get("leak")).toBeNull();
    const t = await env.CF_CACHE_DB.prepare("SELECT name FROM sqlite_master WHERE name='t'").first();
    expect(t).toBeNull();
  });
});

describe("fakes", () => {
  it("fakeQueue records + delivers", async () => {
    const q = fakeQueue<{ id: number }>("jobs");
    await q.send({ id: 1 }); await q.sendBatch([{ body: { id: 2 } }]);
    expect(q.bodies).toEqual([{ id: 1 }, { id: 2 }]);
    q.expectSent({ id: 2 });
    expect(() => q.expectSent({ id: 9 })).toThrow(/no message matching/);
    const got: number[] = [];
    const r = await q.deliver({ queue: (b) => { for (const m of b.messages) { got.push(m.body.id); m.ack(); } } });
    expect(got).toEqual([1, 2]);
    expect(r.explicitAcks).toHaveLength(2);
  });
  it("fakeWorkflow records creates", async () => {
    const wf = fakeWorkflow<{ user: string }>("onboard");
    const inst = await wf.create({ params: { user: "a" } });
    wf.expectCreated({ user: "a" });
    expect((await inst.status()).status).toBe("queued");
    await inst.terminate();
    expect((await (await wf.get(inst.id)).status()).status).toBe("terminated");
  });
  it("a fake queue can be injected into the worker env", async () => {
    const q = fakeQueue();
    const a = testApp({ worker: { fetch: async (_r, e) => { await e.JOBS.send({ hi: 1 }); return new Response("ok"); } }, env: { JOBS: q } });
    await a.fetch("/");
    q.expectSent({ hi: 1 });
  });
});
