import react from "@vitejs/plugin-react";
import { defineAdapter } from "cf-lite/adapter";
import { detectIslands, type DetectOptions } from "./detect.js";

/** `cfLite({ renderer: react() })` - React 19: streaming SSR (Suspense), hydrateRoot, Fast Refresh. */
export default function reactAdapter(options: { /** Auto-islands (`cfLite({ islands: { auto: true } })`): hooks to treat as server-safe / browser-only on top of React's own. */ islands?: DetectOptions } = {}) {
  return defineAdapter({
    id: "@cf-lite/react",
    options,
    extensions: [".tsx", ".jsx", ".ts", ".js"],
    client: "@cf-lite/react/client",
    server: "@cf-lite/react/server",
    islands: { wrap: "@cf-lite/react/islands", mount: "@cf-lite/react/islands-client", detect: (src, file) => detectIslands(src, file, options.islands) },
    vite: () => ({ plugins: [react()] }),
  });
}
export { reactAdapter as react };
