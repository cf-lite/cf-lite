/**
 * Draft mode wiring (`cfLite({ draft })`, docs/draft-mode.md): installs `draft()`, mounts `/api/draft/{enable,disable}`, and
 * generates `/__preview<path>` Worker-first handlers that render every prerendered (`render = "static"`) page on demand, so an
 * editor can see unpublished content on pages the assets layer would otherwise answer before the Worker runs. Preview pages are
 * server-rendered only (no hydration: the client router has no `/__preview` route) and 404 unless the draft cookie is valid.
 * Emits nothing without the option. JSON-only options, except `verifyToken` (a module path imported into the generated app).
 */
import { toWorkerGlob, type PageRoute } from "../scan.js";
import type { DraftOptions } from "../modules/draft.js";
import { defineConvention } from "./types.js";
import { imp } from "./util.js";

export type DraftConfig = Pick<DraftOptions, "maxAge" | "requireToken" | "allowPaths" | "ctxParams" | "tokenOnly" | "frameAncestorsEnv"> & {
  /** Static origins; runtime origins come from env `DRAFT_FRAME_ANCESTORS` / `CMS_ORIGINS` (a function cannot be generated: use `server/` for that). */
  frameAncestors?: string[];
  /** Project-relative module (`server/draft-token.ts`) whose `default` (or named `verifyToken`) is `(token, c) => boolean | Promise<boolean>`; imported into the generated app. */
  verifyToken?: string;
};
const honoPath = (p: string) => p.replace(/\/\*\?$/, "/*");

export const draftConvention = (cfg: DraftConfig) => defineConvention<null>({
  name: "draft",
  scan: () => null,
  emit: (_e, ctx) => {
    const pages = ((ctx.entries["pages"] as PageRoute[] | undefined) ?? []).filter((p) => p.render === "static" && !p.ssrFallback);
    const patterns = pages.map((p) => p.path);
    const { verifyToken, ...json } = cfg;
    const json_ = JSON.stringify({ ...json, previewPatterns: patterns });
    const opts = verifyToken ? `{ ...${json_}, verifyToken: dvt.default ?? dvt.verifyToken }` : json_;
    const layouts = [...new Set(pages.flatMap((p) => p.layouts))];
    const routes = pages.flatMap((p, i) => {
      const base = "/__preview" + (p.path === "/" ? "" : honoPath(p.path));
      const extra = /\*/.test(p.path) ? `, path: ${JSON.stringify("/__preview" + p.path)}` : "";
      const h = `previewOnly(dssr(d${i} as never, { ui: dui, hydrate: false, layouts: [${p.layouts.map((l) => `dl${layouts.indexOf(l)}`).join(", ")}] as never${extra} }))`;
      return [`  .get(${JSON.stringify(base)}, ${h})`, ...(p.path === "/" ? [`  .get("/__preview/", ${h})`] : [])];
    });
    return {
      preImports: [`import { draft, draftRoutes, previewOnly } from "cf-lite/modules/draft";`, ...(pages.length ? [`import { ssr as dssr } from "cf-lite/server";`, `import * as dui from ${JSON.stringify(ctx.adapter?.server ?? "")};`] : [])],
      imports: [...(verifyToken ? [`import * as dvt from ${JSON.stringify(imp(verifyToken.replace(/^\.\//, "")))};`] : []), ...pages.map((p, i) => `import * as d${i} from ${JSON.stringify(imp(p.file))};`), ...layouts.map((l, i) => `import * as dl${i} from ${JSON.stringify(imp(l))};`)],
      appPre: [`  .use(draft(${opts}))`],
      api: [`  .route("/draft", draftRoutes(${opts}))`],
      app: routes,
      workerFirst: pages.length ? ["/__preview", "/__preview/*"] : [],
    };
  },
});
