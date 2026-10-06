import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySecurityHeaders } from "../src/vite-security.js";
import { cspHash, hashesFor, inlineBlocks } from "../src/modules/csp.js";

const site = () => {
  const d = mkdtempSync(join(tmpdir(), "sec-"));
  mkdirSync(join(d, "a/b"), { recursive: true });
  writeFileSync(join(d, "index.html"), "<html><head><style>h1{color:red}</style></head><body><script>window.x=1</script><script src=\"/ext.js\"></script></body></html>");
  writeFileSync(join(d, "a/b/page.html"), "<script>console.log(2)</script>");
  writeFileSync(join(d, "_shell.tpl"), "<script>SHELL_NOT_HASHED()</script>");
  return d;
};

describe("applySecurityHeaders (static CSP)", () => {
  it("hashes inline scripts/styles from every built .html (nested too), never the SSR shell template, and skips external scripts", async () => {
    const d = site();
    const block = await applySecurityHeaders(d, {});
    expect(block).toContain(await cspHash("window.x=1"));
    expect(block).toContain(await cspHash("console.log(2)"));
    expect(block).toContain(await cspHash("h1{color:red}"));
    expect(block).not.toContain(await cspHash("SHELL_NOT_HASHED()"));
    expect(block).toMatch(/Content-Security-Policy:/);
    expect(block).not.toMatch(/unsafe-inline'[^;]*;.*script-src/); // strict preset: no inline script allowance
  });
  it("is idempotent and preserves pre-existing _headers content", async () => {
    const d = site();
    writeFileSync(join(d, "_headers"), "/assets/*\n  Cache-Control: immutable\n");
    await applySecurityHeaders(d, {}); await applySecurityHeaders(d, {});
    const h = readFileSync(join(d, "_headers"), "utf8");
    expect(h.startsWith("/assets/*\n  Cache-Control: immutable")).toBe(true);
    expect(h.match(/# --- cf-lite security ---/g)).toHaveLength(1);
  });
  it("creates _headers when absent; option changes replace the old block", async () => {
    const d = site();
    await applySecurityHeaders(d, { reportOnly: true });
    expect(readFileSync(join(d, "_headers"), "utf8")).toContain("Content-Security-Policy-Report-Only");
    await applySecurityHeaders(d, { hsts: true });
    const h = readFileSync(join(d, "_headers"), "utf8");
    expect(h).not.toContain("Report-Only"); expect(h).toContain("Strict-Transport-Security");
  });
  it("inlineBlocks skips external scripts and collects inline styles", () => {
    const b = inlineBlocks('<script src="a.js"></script><script type="application/ld+json">{"a":1}</script><style media="x">a{}</style>');
    expect(b.styles).toEqual(["a{}"]);
    expect(b.scripts).not.toContain("");
  });
  it("hashesFor dedupes identical blocks across documents", async () => {
    const h = await hashesFor(["<script>a()</script>", "<script>a()</script>", "<script>b()</script>"]);
    expect(h.scriptSrc.filter((x) => x.startsWith("'sha256-"))).toHaveLength(2);
  });
});
