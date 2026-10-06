import type { RobotsConfig } from "cf-lite/modules/sitemap";

// Production: everything allowed. On a *.workers.dev preview cf-lite answers `Disallow: /` + X-Robots-Tag: noindex by itself.
export default { rules: [{ userAgent: "*", allow: "/", disallow: ["/api/"] }] } satisfies RobotsConfig;
