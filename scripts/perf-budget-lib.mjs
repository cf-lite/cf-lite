// Pure helpers for scripts/perf-budget.mjs (unit-tested in packages/cf-lite/test/perf-budget.test.ts).
export const median = (a) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n === 0 ? NaN : n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
export const percentile = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor((s.length * p) / 100))] : NaN; };

/** Allowed maximum for a metric: baseline * (1 + pct/100) + abs. */
export const limitFor = (rule, baseline) => baseline * (1 + rule.pct / 100) + rule.abs;

/**
 * Compare measurements to budgets. `measured` and `budgets.examples` are `{ <example>: { <metric>: number } }`; `budgets.rules` maps a
 * metric to `{ pct, abs }`. A metric without a baseline, or a measured example missing from the budgets, is a failure (budgets must be
 * committed with the code that adds an example). Returns one row per (example, metric).
 */
export function compare(measured, budgets) {
  const rows = [];
  for (const [ex, ms] of Object.entries(measured)) {
    for (const [metric, got] of Object.entries(ms)) {
      const rule = budgets.rules[metric]; const base = budgets.examples?.[ex]?.[metric];
      if (!rule) continue; // measured for information only
      if (base == null) { rows.push({ ex, metric, got, base: null, limit: null, ok: false, why: "no baseline (run --update)" }); continue; }
      const limit = limitFor(rule, base);
      rows.push({ ex, metric, got, base, limit, ok: Number.isFinite(got) && got <= limit, why: Number.isFinite(got) ? undefined : "not measured" });
    }
  }
  return rows;
}

/** Name for a temporary live Worker. Always carries the `cfl-perf-` prefix so a leftover is obviously ours and sweepable. */
export const tempWorkerName = (example, rnd = Math.random().toString(36).slice(2, 8)) => `cfl-perf-${example.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${rnd}`.slice(0, 63);

/** workers.dev URL out of `wrangler deploy` output. */
export const deployedUrl = (out) => /https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i.exec(out)?.[0] ?? null;

/** Examples that may be deployed temporarily: no resource bindings that would attach to (or need) real data. */
export const liveSafe = (wranglerJsonc) => !/"(kv_namespaces|d1_databases|r2_buckets|durable_objects|queues|services|hyperdrive|vectorize|ai|analytics_engine_datasets|workflows|send_email|ratelimits|browser|images)"\s*:/.test(wranglerJsonc);
