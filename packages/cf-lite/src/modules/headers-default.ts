/**
 * Default `_headers` for the assets layer. Hashed build output is immutable for a year; everything else keeps the platform default
 * (`public, max-age=0, must-revalidate` on Workers static assets), so HTML is always revalidated and needs no rule of its own.
 * Pure string helpers (no node APIs); the Vite hook that writes the file is in `../vite-fonts.ts`.
 */
export interface DefaultHeadersOptions {
  /** Build output directory that holds hashed files (Vite `build.assetsDir`, default "assets"). */
  assetsDir?: string;
  /** Extra path -> headers blocks appended after the defaults. */
  extra?: Record<string, Record<string, string>>;
}

export function defaultHeaders(o: DefaultHeadersOptions = {}): string {
  const dir = (o.assetsDir ?? "assets").replace(/^\/+|\/+$/g, "");
  const blocks: Record<string, Record<string, string>> = {
    [`/${dir}/*`]: { "Cache-Control": "public, max-age=31536000, immutable" },
    ...o.extra,
  };
  return Object.entries(blocks).map(([path, h]) => `${path}\n${Object.entries(h).map(([k, v]) => `  ${k}: ${v}`).join("\n")}\n`).join("\n");
}

/** Generated defaults first, then the project's own `public/_headers` (its rules add to / override by header name at the assets layer). */
export function mergeHeaders(defaults: string, user?: string): string {
  const u = user?.trim();
  return u ? `${defaults}\n# --- public/_headers ---\n${u}\n` : defaults;
}
