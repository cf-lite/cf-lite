/**
 * Error digests that carry `notFound()` / `redirect()` across the Flight boundary (docs/design/rsc.md, "notFound / redirect / errors").
 * The rsc environment turns a navigation signal into one of these strings (Flight's `onError` return value is the error `digest` the
 * client-side error carries); the Worker side (`modules/rsc.ts`) and the generated browser boundary parse it back. No React import: safe in every environment.
 */
import { isNavigationSignal } from "../navigation.js";

export const NOT_FOUND_DIGEST = "CFL_NOT_FOUND";
export const FORBIDDEN_DIGEST = "CFL_FORBIDDEN";
export const UNAUTHORIZED_DIGEST = "CFL_UNAUTHORIZED";
const REDIRECT_PREFIX = "CFL_REDIRECT;";

export type DigestSignal = { kind: "not-found" | "forbidden" | "unauthorized" } | { kind: "redirect"; status: number; url: string };

/** Digest string for a thrown navigation signal; undefined for any other error. */
export function digestOf(e: unknown): string | undefined {
  if (!isNavigationSignal(e)) return undefined;
  return e.kind === "redirect" ? `${REDIRECT_PREFIX}${e.status};${e.url}` : e.kind === "forbidden" ? FORBIDDEN_DIGEST : e.kind === "unauthorized" ? UNAUTHORIZED_DIGEST : NOT_FOUND_DIGEST;
}

/** Inverse of `digestOf`; also accepts the signal object itself (a loader's `throw notFound()`). */
export function signalOf(x: unknown): DigestSignal | undefined {
  if (isNavigationSignal(x)) return x.kind === "redirect" ? { kind: "redirect", status: x.status!, url: x.url! } : { kind: x.kind };
  const d = x && typeof x === "object" ? (x as { digest?: unknown }).digest : x;
  if (d === NOT_FOUND_DIGEST) return { kind: "not-found" };
  if (d === FORBIDDEN_DIGEST) return { kind: "forbidden" };
  if (d === UNAUTHORIZED_DIGEST) return { kind: "unauthorized" };
  if (typeof d === "string" && d.startsWith(REDIRECT_PREFIX)) {
    const rest = d.slice(REDIRECT_PREFIX.length), i = rest.indexOf(";");
    const status = Number(rest.slice(0, i));
    if (i > 0 && [301, 302, 303, 307, 308].includes(status)) return { kind: "redirect", status, url: rest.slice(i + 1) };
  }
  return undefined;
}
