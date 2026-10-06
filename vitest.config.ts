import { defineConfig } from "vitest/config";
// Coverage is measured with `npm run test:coverage`; thresholds are a ratchet (current level, docs/performance-budgets.md).
// `import.meta.viteRsc.*` is rewritten by @vitejs/plugin-rsc at build time; under vitest it is routed to `globalThis.__viteRsc` (tests install a fake rsc environment).
const viteRscShim = { name: "cf-lite-viterc-shim", enforce: "pre" as const, transform: (code: string, id: string) => (/modules[\\/]rsc\.ts$/.test(id) ? code.replace(/import\.meta\.viteRsc/g, "globalThis.__viteRsc") : null) };
export default defineConfig({
  plugins: [viteRscShim],
  test: {
    include: ["packages/*/test/**/*.test.ts", "examples/cms-head/test/**/*.test.{ts,tsx}"], environment: "node",
    coverage: {
      provider: "v8", include: ["packages/*/src/**/*.{ts,tsx}"], exclude: ["**/*.d.ts", "packages/*/src/**/types.ts"], // rsc.ts / rsc-client.ts are measured: tests mock the plugin-rsc virtual modules (viteRscShim above) and a DOM
      reporter: ["text-summary", "json-summary", "lcov"], reportsDirectory: "coverage",
      // ratchet: measured 2026-10-02 (rsc.ts + rsc-client.ts back in scope, no exclusions) = 86.43 / 81.19 / 82.26 / 90.08 (stmts/branches/funcs/lines); raise when coverage grows, target 85 on every axis (docs/performance-budgets.md)
      thresholds: { statements: 86, branches: 81, functions: 82, lines: 90 },
    },
  },
});
