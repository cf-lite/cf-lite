// Renders bench/results/*.json -> bench/RESULTS.md
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
const dir = new URL("./results/", import.meta.url);
const order = ["cf-lite", "cf-lite-wrangler", "vinext", "next-opennext", "bare-vite", "bare-wrangler", "cf-lite-ssr", "cf-lite-ssr-preact"];
const rs = order.map((a) => { try { return JSON.parse(readFileSync(new URL(a + ".json", dir), "utf8")); } catch { return null; } }).filter(Boolean);
const kb = (n) => (n == null ? "–" : (n / 1024).toFixed(1) + " KiB");
const row = (label, f) => `| ${label} | ${rs.map((r) => { try { return f(r) ?? "–"; } catch { return "–"; } }).join(" | ")} |`;
const L = [`| metric | ${rs.map((r) => r.app).join(" | ")} |`, `|---|${rs.map(() => "---").join("|")}|`,
  row("status", (r) => (r.buildFailed ? "BUILD FAILED" : r.serveFailed ? "SERVE FAILED" : "ok")),
  row("install (s)", (r) => r.installSeconds.toFixed(1)),
  row("build median (s) [runs]", (r) => `${r.buildMedianSeconds?.toFixed(1)} [${r.buildSeconds.map((x) => x.toFixed(1)).join(", ")}]`),
  row("Worker code, gzip", (r) => kb(r.worker?.gzip)),
  row("Worker code, raw", (r) => kb(r.worker?.raw)),
  row("wrangler dry-run upload gzip", (r) => r.wranglerDryRun ? r.wranglerDryRun.gzipKiB + " KiB" : null),
  row("content page: JS files / gzip", (r) => `${r.contentPage.jsFiles} / ${kb(r.contentPage.totalJsGzip)}`),
  row("content page: HTML (raw)", (r) => kb(r.contentPage.htmlBytes)),
  ...["redirect", "api", "content", "ssr"].flatMap((k) => [
    row(`${k} p50 / p95 / p99 (ms), c=1`, (r) => { const x = r.latencyMs[k]; return `${x.p50} / ${x.p95} / ${x.p99} (HTTP ${x.status})`; }),
    row(`${k} req/s, c=16`, (r) => r.latencyMs[k].rpsC16),
  ])];
const failed = rs.filter((r) => r.buildFailed || r.serveFailed).map((r) => `### ${r.app}\n\`\`\`\n${r.buildFailed ?? r.serveFailed}\n\`\`\``).join("\n");
const by = Object.fromEntries(rs.map((r) => [r.app, r]));
const floorOf = { "cf-lite": "bare-vite", "cf-lite-wrangler": "bare-wrangler", vinext: "bare-vite", "next-opennext": "bare-wrangler" };
const d = (a, k) => { try { return (by[a].latencyMs[k].p50 - by[floorOf[a]].latencyMs[k].p50).toFixed(1); } catch { return "–"; } };
const delta = ["cf-lite", "cf-lite-wrangler", "vinext", "next-opennext"].filter((a) => by[a]).map((a) => `| ${a} | ${d(a, "redirect")} | ${d(a, "api")} | ${d(a, "content")} |`).join("\n");
const r0 = by["cf-lite-ssr"], r1 = by["cf-lite-ssr-preact"];
const pct = (a, b) => (a && b ? ((1 - b / a) * 100).toFixed(0) + "% smaller" : "–");
const preact = r0 && r1 ? `\n## SSR renderer: react vs preact (same app: layouts + head + SSR route)\n\n| metric | react | preact | change |\n|---|---|---|---|\n| Worker code, gzip | ${kb(r0.worker.gzip)} | ${kb(r1.worker.gzip)} | ${pct(r0.worker.gzip, r1.worker.gzip)} |\n| Worker code, raw | ${kb(r0.worker.raw)} | ${kb(r1.worker.raw)} | ${pct(r0.worker.raw, r1.worker.raw)} |\n| build median (s) | ${r0.buildMedianSeconds?.toFixed(1)} | ${r1.buildMedianSeconds?.toFixed(1)} | |\n| ssr route p50 / p99 (ms), c=1 | ${r0.latencyMs.ssr.p50} / ${r0.latencyMs.ssr.p99} | ${r1.latencyMs.ssr.p50} / ${r1.latencyMs.ssr.p99} | launcher floor ~15 ms applies |\n| ssr route req/s, c=16 | ${r0.latencyMs.ssr.rpsC16} | ${r1.latencyMs.ssr.rpsC16} | |\n` : "";
const text = readFileSync(new URL("./methodology.md", import.meta.url), "utf8");
writeFileSync(new URL("./RESULTS.md", import.meta.url), `# Benchmark results\n\nHost: ${rs[0]?.cpuModel} x${rs[0]?.cpus}, Node ${rs[0]?.node}, ${rs[0]?.date}\n\n${L.join("\n")}\n\n## p50 latency above the control floor (ms)\n\nVariant p50 minus the p50 of the bare Worker (no framework, no Hono) served by the *same launcher* on the same route. **Negative = the request never entered the Worker** (assets layer answered it, faster than the floor). bare-vite = floor for cf-lite/vinext (\`vite preview\`); bare-wrangler = floor for cf-lite-wrangler/next-opennext (\`wrangler dev\`).\n\n| variant | redirect | api | content |\n|---|---|---|---|\n${delta}\n${preact}\n${text}\n${failed}\n`);
console.log(L.join("\n"));
