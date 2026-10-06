import { security } from "cf-lite/modules/csp";

// SSR pages get a nonce policy from the Worker; static pages got hashes in _headers at build time. /live is left out: React's inline Suspense streaming scripts carry no nonce yet (a cf-lite gap that is not about islands).
export const config = { matcher: ["/ssr", "/hyd", "/api/:path*"] };

export default security({ preset: "strict" });
