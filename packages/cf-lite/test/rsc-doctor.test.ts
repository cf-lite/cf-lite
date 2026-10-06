import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctor, rscPages } from "../src/doctor.js";

const GOOD = { "@vitejs/plugin-rsc": "0.5.35", react: "19.3.0", "react-dom": "19.3.0", "react-server-dom-webpack": "19.3.0", "rsc-html-stream": "0.0.8" };
const app = (o: { flags?: string[]; deps?: Record<string, string>; rsc?: boolean; headers?: string; middleware?: string } = {}) => {
  const d = mkdtempSync(join(tmpdir(), "cfl-rsc-doc-"));
  writeFileSync(join(d, "wrangler.jsonc"), JSON.stringify({ name: "x", main: "w.ts", compatibility_date: new Date().toISOString().slice(0, 10), compatibility_flags: o.flags ?? ["nodejs_compat"] }));
  writeFileSync(join(d, "package.json"), JSON.stringify({ dependencies: o.deps ?? GOOD }));
  mkdirSync(join(d, "app/routes"), { recursive: true });
  writeFileSync(join(d, "app/routes/p.tsx"), o.rsc === false ? 'export const render = "ssr";\n' : 'export const render = "rsc";\nexport default () => null;\n');
  if (o.headers) { mkdirSync(join(d, "public")); writeFileSync(join(d, "public/_headers"), o.headers); }
  if (o.middleware) { mkdirSync(join(d, "server")); writeFileSync(join(d, "server/middleware.ts"), o.middleware); }
  return d;
};
const codes = (d: string) => doctor(d).map((f) => f.code);

describe("doctor: render=\"rsc\" checks (CFL014-016)", () => {
  it("finds rsc pages; apps without them see no RSC findings at all", () => {
    expect(rscPages(app())).toEqual(["app/routes/p.tsx"]);
    const d = app({ rsc: false, flags: [], deps: {} });
    expect(codes(d).filter((c) => /CFL01[456]/.test(c))).toEqual([]);
  });
  it("a correct app is clean", () => { expect(codes(app()).filter((c) => /CFL01[456]/.test(c))).toEqual([]); });
  it("CFL014: no nodejs_compat / nodejs_als", () => {
    expect(codes(app({ flags: [] }))).toContain("CFL014");
    expect(codes(app({ flags: ["nodejs_als"] }))).not.toContain("CFL014");
  });
  it("CFL015: missing, ranged, mismatched or vulnerable pins", () => {
    const f = (deps: Record<string, string>) => doctor(app({ deps })).filter((x) => x.code === "CFL015");
    expect(f({ ...GOOD, "rsc-html-stream": "" })[0].message).toMatch(/missing: rsc-html-stream/);
    expect(f({ ...GOOD, "@vitejs/plugin-rsc": "^0.5.35" })[0].message).toMatch(/not an exact version/);
    expect(f({ ...GOOD, "react-dom": "19.2.9" })[0].message).toMatch(/same version/);
    expect(f({ ...GOOD, react: "19.2.6", "react-dom": "19.2.6", "react-server-dom-webpack": "19.2.6" })[0].message).toMatch(/patched floor/);
    expect(f({ ...GOOD, react: "19.2.8", "react-dom": "19.2.8", "react-server-dom-webpack": "19.2.8" })).toEqual([]);
  });
  it("CFL016: strict script-src with no nonce source warns; security() or unsafe-inline silences it", () => {
    const h = "/*\n  Content-Security-Policy: default-src 'self'; script-src 'self'\n";
    expect(doctor(app({ headers: h })).find((x) => x.code === "CFL016")?.level).toBe("warn");
    expect(codes(app({ headers: h, middleware: 'app.use(security({ preset: "strict" }))' }))).not.toContain("CFL016");
    expect(codes(app({ headers: h.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'") }))).not.toContain("CFL016");
  });
});

describe("doctor CFL015: plugin-rsc floor", () => {
  it("an exact but vulnerable @vitejs/plugin-rsc is flagged", () => {
    expect(doctor(app({ deps: { ...GOOD, "@vitejs/plugin-rsc": "0.5.1" } })).find((x) => x.code === "CFL015")?.message).toMatch(/below the patched floor 0\.5\.26/);
    expect(codes(app({ deps: { ...GOOD, "@vitejs/plugin-rsc": "0.5.26" } }))).not.toContain("CFL015");
  });
});
