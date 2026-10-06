import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { TURNSTILE_TEST, turnstile, turnstileWidget, verifyTurnstile } from "../src/modules/turnstile.js";

const fake = (resp: unknown, status = 200, seen: FormData[] = []) => (async (_u: string, init: RequestInit) => { seen.push(init.body as FormData); return new Response(JSON.stringify(resp), { status }); }) as unknown as typeof fetch;

describe("verifyTurnstile (fails closed)", () => {
  it("passes on success and sends secret/response/remoteip", async () => {
    const seen: FormData[] = [];
    const r = await verifyTurnstile("tok", { secret: "s", ip: "1.2.3.4", fetch: fake({ success: true, hostname: "a.example", action: "login" }, 200, seen) });
    expect(r.ok).toBe(true); expect(seen[0].get("secret")).toBe("s"); expect(seen[0].get("response")).toBe("tok"); expect(seen[0].get("remoteip")).toBe("1.2.3.4");
  });
  it.each([
    ["no secret", () => verifyTurnstile("t", {})],
    ["no token", () => verifyTurnstile("", { secret: "s", fetch: fake({ success: true }) })],
    ["huge token", () => verifyTurnstile("x".repeat(3000), { secret: "s", fetch: fake({ success: true }) })],
    ["success:false", () => verifyTurnstile("t", { secret: "s", fetch: fake({ success: false, "error-codes": ["invalid-input-response"] }) })],
    ["http 500", () => verifyTurnstile("t", { secret: "s", fetch: fake({ success: true }, 500) })],
    ["network error", () => verifyTurnstile("t", { secret: "s", fetch: (async () => { throw new Error("down"); }) as unknown as typeof fetch })],
    ["garbage body", () => verifyTurnstile("t", { secret: "s", fetch: (async () => new Response("<html>")) as unknown as typeof fetch })],
    ["success as string", () => verifyTurnstile("t", { secret: "s", fetch: fake({ success: "true" }) })],
    ["action mismatch", () => verifyTurnstile("t", { secret: "s", expectedAction: "login", fetch: fake({ success: true, action: "signup" }) })],
    ["hostname mismatch", () => verifyTurnstile("t", { secret: "s", expectedHostname: "a.example", fetch: fake({ success: true, hostname: "evil.example" }) })],
  ])("rejects: %s", async (_n, fn) => { expect((await fn()).ok).toBe(false); });
  it("dummy test keys are exported", () => { expect(TURNSTILE_TEST.secretPass).toMatch(/^1x/); expect(TURNSTILE_TEST.secretFail).toMatch(/^2x/); });
});

describe("turnstile() middleware", () => {
  const app = (o = {}) => new Hono<{ Bindings: { TURNSTILE_SECRET?: string } }>().post("/s", turnstile({ fetch: fake({ success: true }), ...o }), (c) => c.text("ok"));
  it("503 when unconfigured (never silently skipped)", async () => { expect((await app().request("/s", { method: "POST" }, {})).status).toBe(503); });
  it("403 without token; ok via header, json and form", async () => {
    const env = { TURNSTILE_SECRET: "s" }; const a = app();
    expect((await a.request("/s", { method: "POST" }, env)).status).toBe(403);
    expect((await a.request("/s", { method: "POST", headers: { "cf-turnstile-response": "t" } }, env)).status).toBe(200);
    expect((await a.request("/s", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ "cf-turnstile-response": "t" }) }, env)).status).toBe(200);
    expect((await a.request("/s", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "cf-turnstile-response=t" }, env)).status).toBe(200);
  });
  it("403 when siteverify rejects", async () => {
    const r = await app({ fetch: fake({ success: false, "error-codes": ["timeout-or-duplicate"] }) }).request("/s", { method: "POST", headers: { "cf-turnstile-response": "t" } }, { TURNSTILE_SECRET: "s" });
    expect(r.status).toBe(403); expect(await r.json()).toMatchObject({ reason: "timeout-or-duplicate" });
  });
  it("widget escapes the site key", () => { expect(turnstileWidget('a"><script>')).not.toContain('"><script>'); expect(turnstileWidget("k", { action: "login" })).toContain('data-action="login"'); });
});
