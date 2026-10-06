/** `server/routes/**` -> non-API Hono handlers mounted at their own URL (`/feed.xml`, `/og/:slug`), Worker-first. */
import { scanHandlers, toWorkerGlobs, type HandlerRoute } from "../scan.js";
import { defineConvention } from "./types.js";
import { imp } from "./util.js";

export const routesConvention = defineConvention<HandlerRoute[]>({
  name: "routes",
  scan: ({ root }) => scanHandlers(root),
  emit: (rs) => ({
    imports: rs.map((r, i) => `import h${i} from ${JSON.stringify(imp(r.file))};`),
    appPre: rs.map((r, i) => `  .route(${JSON.stringify(r.mount.replace(/\/\*\??$/, "/*"))}, h${i})`),
    workerFirst: [...new Set(rs.flatMap((r) => toWorkerGlobs(r.mount)))],
  }),
});
