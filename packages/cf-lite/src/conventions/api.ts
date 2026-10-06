/** `server/api/**` -> `/api/*` Hono sub-apps. */
import { scanApi, type ApiRoute } from "../scan.js";
import { defineConvention } from "./types.js";
import { imp } from "./util.js";

export const apiConvention = defineConvention<ApiRoute[]>({
  name: "api",
  scan: ({ root }) => scanApi(root),
  emit: (api) => ({
    imports: api.map((a, i) => `import a${i} from ${JSON.stringify(imp(a.file))};`),
    api: api.map((a, i) => `  .route(${JSON.stringify(a.mount)}, a${i})`),
  }),
});
