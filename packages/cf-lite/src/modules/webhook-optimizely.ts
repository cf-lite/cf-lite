/**
 * STUB adapter: Optimizely Graph webhooks. Shape taken ONLY from public docs (verified 2026-10-01):
 *  - https://docs.developers.optimizely.com/platform-optimizely/docs/webhooks            (payload: id, timestamp, tenantId, type{subject,action}, data)
 *  - https://docs.developers.optimizely.com/platform-optimizely/docs/manage-webhooks     (topics `doc.updated`, `doc.expired`, `bulk.completed`; registration body)
 *  - https://docs.developers.optimizely.com/digital-experience-platform/docs/nextjs-isr-caching-and-optimizely-graph-webhooks
 *      (docId = `{UUID}_{language}_Published`; the callback is authenticated by an `x-api-key` header you set at registration)
 * Ids: the docId uuid is emitted WITHOUT dashes (32 hex) = Graph `_metadata.key`, so `content:<type>:<key>` tags written by loaders match (fixture-tested).
 * NOT verified against a live tenant (no account): treat as a stub. HMAC signing exists on Graph but its header format is not
 * documented publicly, so use `optimizelyVerify` (shared secret in `x-api-key`) until it is confirmed.
 */
import type { ChangeEvent, VerifyOptions, WebhookAdapter } from "./webhook.js";

export const optimizelyVerify: VerifyOptions = { mode: "secret", signatureHeader: "x-api-key" };

export interface OptimizelyOptions {
  /** Content type recorded on events (Graph docIds carry no type). Default "content". Use `tags` below for a finer map. */
  type?: string;
  /** `bulk.completed` carries only a journalId - no ids. Default true: treat it as a coarse purge of everything (`all`). */
  bulkPurgesAll?: boolean;
  /** Graph docIds ending `_Draft` are draft saves, not publishes. Default false: ignored (a draft save must not purge published pages). */
  includeDrafts?: boolean;
  /** Keep the docId's dashes in `id` (default false: stripped, so `id` equals Graph's 32-hex `_metadata.key` that loaders pass to `trackContent`). */
  keepDashes?: boolean;
}
const DOC_ID = /^([0-9a-fA-F-]{8,})(?:_([A-Za-z0-9-]+?))?(?:_(Published|Draft))?$/;

export function optimizelyAdapter(o: OptimizelyOptions = {}): WebhookAdapter {
  const type = o.type ?? "content";
  return {
    name: "optimizely-graph",
    deliveryId: (b) => (b && typeof b === "object" && typeof (b as { id?: unknown }).id === "string" ? (b as { id: string }).id : undefined),
    parse(body) {
      const b = body as { type?: { subject?: unknown; action?: unknown }; data?: { docId?: unknown; journalId?: unknown } };
      const subject = b?.type?.subject, action = b?.type?.action;
      if (typeof subject !== "string" || typeof action !== "string") throw new Error("not an Optimizely Graph webhook (type.subject/type.action missing)");
      if (subject === "bulk" && action === "completed") return o.bulkPurgesAll === false ? [] : [{ action: "publish", all: true }];
      if (subject === "doc" && (action === "updated" || action === "expired")) {
        const docId = b.data?.docId;
        if (typeof docId !== "string") throw new Error("data.docId missing");
        const m = DOC_ID.exec(docId);
        if (!m) throw new Error("unrecognised docId format");
        if (m[3] === "Draft" && !o.includeDrafts) return [];
        const id = m[1].toLowerCase();
        const ev: ChangeEvent = { action: action === "expired" ? "unpublish" : "publish", type, id: o.keepDashes ? id : id.replace(/-/g, "") };
        if (m[2]) ev.locale = m[2];
        return [ev];
      }
      return []; // other topics: acknowledged, ignored
    },
  };
}
