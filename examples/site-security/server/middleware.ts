import { security } from "cf-lite/modules/csp";

// Only the paths that reach the Worker anyway (SSR pages, /api): static pages get their policy from `_headers` at build time.
export const config = { matcher: ["/ssr", "/api/:path*"] };

export default security({ preset: "strict" });
