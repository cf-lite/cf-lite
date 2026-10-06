/**
 * Project-local convention (not a built-in): mounts the `IMAGES`-binding route and the Worker-first glob for it.
 *
 *   cfLite({ renderer: react(), conventions: [images({ allowHosts: ["cdn.example.com"], r2: ["MEDIA"] })] })
 *
 * The config must be JSON-serialisable (it is written into `.cf-lite/app.ts`). Call `configureImages(sameConfig)` from app code
 * so `<Image>` builds URLs for the same backend/whitelist. docs/images.md.
 */
import { defineConvention } from "./types.js";
import type { ImagesConfig } from "../modules/images.js";

export function images(config: ImagesConfig = {}) {
  const route = config.route ?? "/_img";
  return defineConvention<null>({
    name: "images",
    scan: () => null,
    emit: () => (config.backend ?? "binding") !== "binding" ? {} : {
      imports: [`import { imagesHandler } from "cf-lite/modules/images";`],
      app: [`  .get(${JSON.stringify(route)}, imagesHandler(${JSON.stringify(config)}))`],
      workerFirst: [route],
      checks: [(w) => (w.images ? [] : [`images(): backend "binding" needs \`"images": { "binding": "IMAGES" }\` in wrangler config`])],
    },
  });
}
