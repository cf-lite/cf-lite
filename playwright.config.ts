import { defineConfig, devices } from "@playwright/test";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
// Miniflare hangs under Bun (docs/bun-first.md), so the dev server is started with Node explicitly.
const wrangler = join(dirname(createRequire(import.meta.url).resolve("wrangler/package.json")), "bin/wrangler.js");
// PW_DEMO_PORT moves the demo server when 18999 is taken (shared host).
// Browsers: chromium only by default (CI). PW_BROWSERS=chromium,firefox,webkit (bun run test:browser:all) runs the whole suite in each; docs/testing.md.
// Requires built apps (bun run test:browser does that). PW_ONLY=site-vue runs just that app.
// `site*` are the same app in react / preact / vue / svelte: e2e/site.spec.ts is one shared suite run against each.
const only = process.env.PW_ONLY;
const browsers = (process.env.PW_BROWSERS ?? "chromium").split(",").map((b) => b.trim()).filter(Boolean);
const device = { chromium: "Desktop Chrome", firefox: "Desktop Firefox", webkit: "Desktop Safari" } as const;
const servers = [
  { name: "demo", port: Number(process.env.PW_DEMO_PORT ?? 18999), dir: "examples/demo" },
  { name: "site", port: 19998, dir: "examples/site" },
  { name: "site-preact", port: 19997, dir: "examples/site-preact" },
  { name: "site-vue", port: 19996, dir: "examples/site-vue" },
  { name: "site-svelte", port: 19995, dir: "examples/site-svelte" },
    { name: "site-images", port: 19992, dir: "examples/site-images", spec: "images" }, // WP-IMAGES: layout-shift check
  { name: "site-htmx", port: 19993, dir: "examples/site-htmx", spec: "htmx" }, // renderer "none" + htmx/Alpine: its own spec (no routes/layouts)
  { name: "site-forms", port: 19991, dir: "examples/site-forms", spec: "actions" }, // server actions + forms: its own spec (no-JS and JS flows)
  { name: "site-security", port: 19990, dir: "examples/site-security", spec: "security" }, // WP-SECURITY: strict CSP on static + SSR pages, no violations
  { name: "site-islands", port: 19988, dir: "examples/site-islands", spec: "islands" }, // SSR islands: hydration per strategy, zero JS without islands
  { name: "site-islands-auto", port: 19985, dir: "examples/site-islands-auto", spec: "islands-auto" }, // auto-islands: plain components, no *.island.tsx
  { name: "docs", port: 19987, dir: "site", spec: "docs-a11y" }, // docs site `site/`: axe gate (WCAG 2.x A/AA, light + dark)
  { name: "site-islands-vue", port: 19986, dir: "examples/site-islands-vue", spec: "islands-vue" }, // Vue SSR islands (*.island.vue): same strategies, static + streamed SSR
  { name: "cms-head", port: 19989, dir: "examples/cms-head", spec: "cms-head" }, // WP-CMSDEMO: editor iframes the head in preview, live refresh on save
].filter((s) => !only || s.name === only);
export default defineConfig({
  testDir: "e2e",
  webServer: servers.map((s) => ({ command: `node ${wrangler} dev --port ${s.port}`, cwd: s.dir, url: `http://localhost:${s.port}`, timeout: 60_000, reuseExistingServer: false })),
  projects: [
    ...(only && only !== "fonts" ? [] : [{ name: "fonts", testMatch: "**/fonts.spec.ts" }]), // chromium-only (font metrics are engine specific)
    ...servers.flatMap((s) => browsers.map((b) => ({
      name: b === "chromium" ? s.name : `${s.name}-${b}`,
      testMatch: `**/${(s as { spec?: string }).spec ?? (s.name === "demo" ? "smoke" : "site")}.spec.ts`,
      use: { ...devices[device[b as keyof typeof device]], baseURL: `http://localhost:${s.port}` },
    }))),
  ],
});
