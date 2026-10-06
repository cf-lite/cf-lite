import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { testApp, loginAs, runScheduled, fakeQueue, fakeWorkflow } from "../../dist/index.js";
import worker from "../worker";

describe("gate", () => {
  it("rejects anonymous requests", async () => {
    expect((await testApp().fetch("/api/notes")).status).toBe(401);
  });
  it("login route is 404 without the secret, 403 with a wrong one", async () => {
    const off = testApp({ worker, env: { E2E_LOGIN_SECRET: undefined } });
    expect((await off.fetch("/__e2e/login", { method: "POST" })).status).toBe(404);
    const bad = await testApp().fetch("/__e2e/login", { method: "POST", headers: { "x-e2e-secret": "nope" } });
    expect(bad.status).toBe(403);
  });
  it("loginAs opens the gate; each user only sees their notes (D1 migrations applied)", async () => {
    const alice = testApp(), bob = testApp();
    await loginAs(alice, "alice"); await loginAs(bob, "bob");
    expect(alice.cookies.get("sid")).toBe("alice");
    await alice.fetch("/api/notes", { method: "POST", body: JSON.stringify({ body: "hi" }) });
    expect(await (await alice.fetch("/api/notes")).json()).toEqual([{ body: "hi" }]);
    expect(await (await bob.fetch("/api/notes")).json()).toEqual([]);
  });
  it("producing side effects reach fake queue + workflow", async () => {
    const JOBS = fakeQueue<{ kind: string; owner: string }>("jobs"), FLOW = fakeWorkflow<{ owner: string }>("flow");
    const app = testApp({ worker, env: { JOBS, FLOW } });
    await loginAs(app, "carol");
    await app.fetch("/api/notes", { method: "POST", body: JSON.stringify({ body: "x" }) });
    JOBS.expectSent({ kind: "note", owner: "carol" });
    FLOW.expectCreated({ owner: "carol" });
    // and the consumer handles what was produced
    await JOBS.deliver(worker);
    expect(await env.KV.get("seen:carol")).toBe("1");
  });
  it("cron writes KV", async () => {
    await runScheduled(worker);
    expect(await env.KV.get("last-cron")).toBe("ran");
  });
});

describe("isolation: storage does not leak between tests", () => {
  it("A inserts a row and a KV key", async () => {
    await env.DB.prepare("INSERT INTO notes (owner, body) VALUES ('z','leak')").run();
    await env.KV.put("leak", "1");
  });
  it("B starts clean (table re-created by migrations, empty)", async () => {
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM notes").first<{ n: number }>())?.n).toBe(0);
    expect(await env.KV.get("leak")).toBeNull();
  });
});
