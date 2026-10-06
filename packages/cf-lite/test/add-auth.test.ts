import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addAuth, applyFeatures, patchWrangler } from "../src/add-auth.js";

describe("cf-lite add auth", () => {
  it("patchWrangler inserts once, preserves comments, extends an existing d1 array", () => {
    const src = `{\n  // keep me\n  "name": "x"\n}`;
    const out = patchWrangler(src, "x")!;
    expect(out).toContain("// keep me"); expect(out).toContain('"binding": "AUTH_DB"'); expect(patchWrangler(out, "x")).toBe(out);
    const two = patchWrangler(`{ "d1_databases": [{ "binding": "DB" }] }`, "x")!;
    expect(two).toMatch(/"d1_databases": \[ \{ "binding": "AUTH_DB".*\},\{ "binding": "DB" \}\]/);
    expect(patchWrangler("no braces", "x")).toBeNull();
  });
  it("copies the template, never overwrites, idempotent", () => {
    const d = mkdtempSync(join(tmpdir(), "addauth-"));
    writeFileSync(join(d, "wrangler.jsonc"), `{ "name": "app" }`);
    const a = addAuth(d);
    expect(a.changed).toEqual(expect.arrayContaining(["server/api/auth.ts", "server/auth.ts", "migrations/0001_auth.sql", "wrangler.jsonc"]));
    writeFileSync(join(d, "server/auth.ts"), "// mine");
    expect(addAuth(d).changed).toEqual([]);
    expect(readFileSync(join(d, "server/auth.ts"), "utf8")).toBe("// mine");
    expect(existsSync(join(d, ".dev.vars.example"))).toBe(true);
  });

  const scaffold = (o: Parameters<typeof addAuth>[2]) => {
    const d = mkdtempSync(join(tmpdir(), "addauth-"));
    writeFileSync(join(d, "wrangler.jsonc"), `{ "name": "app" }`);
    addAuth(d, () => {}, o);
    return { route: readFileSync(join(d, "server/api/auth.ts"), "utf8"), env: readFileSync(join(d, ".dev.vars.example"), "utf8") };
  };
  it("scaffold sessions are D1-backed so logout/revokeUser really revoke (sec10)", () => {
    const d = mkdtempSync(join(tmpdir(), "addauth-"));
    writeFileSync(join(d, "wrangler.jsonc"), `{ "name": "app" }`);
    addAuth(d, () => {}, {});
    expect(readFileSync(join(d, "server/auth.ts"), "utf8")).toMatch(/^\s*store: d1Store\(env\.AUTH_DB!\),/m);
  });
  it("rate-limit + Turnstile are wired by default", () => {
    const { route, env } = scaffold({});
    expect(route).toContain('from "cf-lite/modules/ratelimit"'); expect(route).toContain("failOpen: false");
    expect(route).toMatch(/\.get\("\/callback", callbackLimit/); expect(route).toMatch(/\.post\("\/logout", logoutLimit, csrf\(\)/);
    expect(route).toContain('from "cf-lite/modules/turnstile"'); expect(route).toMatch(/\.post\("\/login", loginLimit, csrf\(\), verifyHuman/);
    expect(env).toContain("TURNSTILE_SECRET");
    expect(route).not.toContain("@cfl:"); expect(route).not.toContain("(_c, next) => next()");
  });
  it("--no-ratelimit / --no-turnstile opt out independently", () => {
    const a = scaffold({ rateLimit: false });
    expect(a.route).not.toContain("cf-lite/modules/ratelimit"); expect(a.route).toContain("cf-lite/modules/turnstile"); expect(a.route).not.toContain("@cfl:");
    const b = scaffold({ turnstile: false });
    expect(b.route).toContain("cf-lite/modules/ratelimit"); expect(b.route).not.toContain("cf-lite/modules/turnstile"); expect(b.route).not.toContain("verifyHuman"); expect(b.route).toContain('.get("/login", loginLimit, (c) => startOAuth');
    const c = scaffold({ rateLimit: false, turnstile: false });
    expect(c.route).not.toMatch(/cf-lite\/modules\/(ratelimit|turnstile)/);
    expect(c.route).toContain("(_c, next) => next()");
  });
  it("applyFeatures strips markers and unmatched branches", () => {
    const t = "a\n// @cfl:x\nON\n// @cfl:no-x\nOFF\n// @cfl:end\nz";
    expect(applyFeatures(t, { x: true })).toBe("a\nON\nz"); expect(applyFeatures(t, { x: false })).toBe("a\nOFF\nz");
  });
});
