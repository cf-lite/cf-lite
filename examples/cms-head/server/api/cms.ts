import { createMockCms, kvStore } from "../../cms/mock";
import webhooks from "./webhooks";

// The mock CMS mounted at /api/cms (graphql, admin/*): curl-able, and the e2e drives it. Its publish webhook is delivered in-process to the
// head's own receiver (no self-fetch); a real CMS would POST to https://<head>/api/webhook/cms instead.
export const mockCms = /* @__PURE__ */ createMockCms({
  store: (env) => kvStore(env.CONTENT),
  // The "preview button": a page/article opens through cf-lite/modules/draft's enable endpoint (sets the cookie, redirects to the page).
  previewUrl: (env, e) => (e.path ? `/api/draft/enable?secret=${encodeURIComponent(env.DRAFT_SECRET.split(",")[0])}&path=${encodeURIComponent(`/${e.locale}${e.path === "/" ? "" : e.path}`)}` : null),
  deliver: (req, env) => Promise.resolve(webhooks.fetch(new Request("http://head.internal/cms", req), env)),
});
export default mockCms;
