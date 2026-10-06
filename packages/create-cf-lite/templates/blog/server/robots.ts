import type { RobotsConfig } from "cf-lite/modules/sitemap";

// On a *.workers.dev preview cf-lite answers `Disallow: /` + noindex by itself.
export default { rules: [{ userAgent: "*", allow: "/", disallow: ["/api/"] }] } satisfies RobotsConfig;
