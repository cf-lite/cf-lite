import { security } from "cf-lite/modules/csp";

export const config = { matcher: ["/live", "/api/:path*"] };

export default security({ preset: "strict" });
