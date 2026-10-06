/**
 * Control-flow sentinels for loaders (`cf-lite/navigation`): `throw notFound()`, `throw redirect("/login")`.
 * `ssr()` catches them before the first byte is written, so the status line / Location header are real.
 * Identified by a global symbol, not `instanceof`, so a duplicated copy of this module (bundler dedupe miss) still works.
 */
const KEY = Symbol.for("cf-lite.navigation");

export interface NavigationSignal { readonly [KEY]: true; kind: "not-found" | "redirect" | "forbidden" | "unauthorized"; url?: string; status?: number }
export type RedirectStatus = 301 | 302 | 303 | 307 | 308;

export class NotFoundSignal extends Error implements NavigationSignal {
  readonly [KEY] = true as const;
  kind = "not-found" as const;
  constructor() { super("NEXT_NOT_FOUND"); }
}
export class ForbiddenSignal extends Error implements NavigationSignal {
  readonly [KEY] = true as const;
  kind = "forbidden" as const;
  constructor() { super("NEXT_FORBIDDEN"); }
}
export class UnauthorizedSignal extends Error implements NavigationSignal {
  readonly [KEY] = true as const;
  kind = "unauthorized" as const;
  constructor() { super("NEXT_UNAUTHORIZED"); }
}
export class RedirectSignal extends Error implements NavigationSignal {
  readonly [KEY] = true as const;
  kind = "redirect" as const;
  constructor(public url: string, public status: RedirectStatus) { super(`NEXT_REDIRECT ${status} ${url}`); }
}

/** Throw (or return it from `throw`) inside a loader to render the nearest `_not-found` with status 404. */
export const notFound = (): never => { throw new NotFoundSignal(); };
/** Throw inside a loader / action to render the nearest `_forbidden` with status 403 (authenticated, not allowed). */
export const forbidden = (): never => { throw new ForbiddenSignal(); };
/** Throw inside a loader / action to render the nearest `_unauthorized` with status 401 (not authenticated). */
export const unauthorized = (): never => { throw new UnauthorizedSignal(); };
/** Status of a boundary-rendering signal (everything but a redirect). */
export const signalStatus = (k: "not-found" | "forbidden" | "unauthorized"): 404 | 403 | 401 => (k === "forbidden" ? 403 : k === "unauthorized" ? 401 : 404);
/** Temporary redirect (default 307, keeps the method). */
export const redirect = (url: string, status: 301 | 302 | 303 | 307 | 308 = 307): never => { throw new RedirectSignal(url, status); };
/** 308 redirect. */
export const permanentRedirect = (url: string): never => redirect(url, 308);

export const isNavigationSignal = (e: unknown): e is NotFoundSignal | RedirectSignal | ForbiddenSignal | UnauthorizedSignal => !!e && typeof e === "object" && (e as any)[KEY] === true;
