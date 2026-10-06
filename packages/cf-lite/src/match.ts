/** URL pattern matching shared by the client router and the SSR handlers (`:param`, `*` = catch-all with >= 1 segment, `*?` = optional catch-all). */
export function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const a = pattern.split("/").filter(Boolean), b = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "*?") { params["*"] = b.slice(i).join("/"); return params; }
    if (a[i] === "*") { if (b[i] === undefined) return null; params["*"] = b.slice(i).join("/"); return params; }
    if (b[i] === undefined) return null;
    if (a[i].startsWith(":")) params[a[i].slice(1)] = b[i];
    else if (a[i] !== b[i]) return null;
  }
  return a.length === b.length ? params : null;
}
