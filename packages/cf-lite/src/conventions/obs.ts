/**
 * Observability conventions (docs/observability.md).
 *
 *  - built-in `obs`: `server/error.ts` (default export = `ErrorOptions`, e.g. `{ reporters: [sentry(...)] }`) becomes the generated
 *    app's `.onError(...)`. Absent file = no `onError` emitted, nothing imported (zero bytes).
 *  - project-local `metrics()`: mounts the vitals beacon route `POST /_m` + its Worker-first glob (only that path wakes the Worker).
 *      cfLite({ conventions: [metrics({ binding: "METRICS" })] })
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { defineConvention } from "./types.js";
import type { MetricsHandlerOptions } from "../modules/metrics.js";

export const obsConvention = defineConvention<string | null>({
  name: "obs",
  scan: ({ root }) => ["ts", "tsx", "js", "mjs"].map((e) => `server/error.${e}`).find((f) => existsSync(join(root, f))) ?? null,
  emit: (file) => {
    if (!file) return {};
    return {
      imports: [`import { errorHandler } from "cf-lite/modules/error";`, `import errorOpts from ${JSON.stringify("../" + file.replace(/\.(tsx|ts|js|mjs)$/, ""))};`],
      app: [`  .onError(errorHandler(errorOpts))`],
    };
  },
});

export function metrics(config: MetricsHandlerOptions & { route?: string } = {}) {
  const route = config.route ?? "/_m";
  const { route: _r, ...opts } = config;
  return defineConvention<null>({
    name: "metrics",
    scan: () => null,
    emit: () => ({
      imports: [`import { metricsHandler } from "cf-lite/modules/metrics";`],
      app: [`  .post(${JSON.stringify(route)}, metricsHandler(${JSON.stringify(opts)}))`],
      workerFirst: [route],
      checks: [(w) => {
        const b = opts.binding ?? "METRICS";
        const ds = (w.analytics_engine_datasets ?? []) as { binding?: string }[];
        return ds.some((d) => d.binding === b) ? [] : [`metrics(): no analytics_engine_datasets binding "${b}" in wrangler config (points are dropped until added)`];
      }],
    }),
  });
}
