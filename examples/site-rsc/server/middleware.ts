import { security } from "cf-lite/modules/csp";

// Nonce CSP on one rsc route (P4): the bootstrap script and every inline Flight chunk must carry the per-request nonce.
export const config = { matcher: ["/rsc-csp"] };

export default security({ preset: "strict" });
