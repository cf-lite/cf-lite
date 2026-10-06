import type { ComponentChildren } from "preact";
import nav from "../../.content/nav.json";

const groups = ["Start", "Reference", "Evidence"];
export const pages = nav as { slug: string; title: string; group: string }[];
const Logo = () => (
  <svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#2f6f5e" /><path d="M9 20c0-4 3-7 7-7s7 3 7 7" fill="none" stroke="#f4f1ea" stroke-width="3" stroke-linecap="round" /><circle cx="16" cy="10" r="2.2" fill="#f4f1ea" /></svg>
);

export function Sidebar({ current }: { current?: string }) {
  return (
    <nav class="side" aria-label="Documentation">
      {groups.map((g) => (
        <>
          <h2>{g}</h2>
          <ul>
            {pages.filter((p) => p.group === g).map((p) => (
              <li><a href={`/docs/${p.slug}/`} aria-current={p.slug === current ? "page" : undefined}>{p.title}</a></li>
            ))}
          </ul>
        </>
      ))}
    </nav>
  );
}

// Plain <a> everywhere: these pages are static documents, navigation is a normal document load (no client router, no JS).
export function Shell({ current, toc, bare, children }: { current?: string; toc?: boolean; bare?: boolean; children?: ComponentChildren }) {
  return (
    <>
      <a class="skip" href="#main">Skip to content</a>
      <header class="top">
        <div class="top-in">
          <a class="brand" href="/"><Logo />cf-lite <small>docs</small></a>
          <nav aria-label="Primary">
            <a class="hide-sm" href="/docs/getting-started/">Docs</a>
            <a class="hide-sm" href="/docs/benchmarks/">Benchmarks</a>
            <a href="/search/">Search</a>
          </nav>
        </div>
      </header>
      {bare ? children : (
        <div class={toc ? "wrap has-toc" : "wrap"}>
          <details class="menu"><summary>Documentation menu</summary><Sidebar current={current} /></details>
          <Sidebar current={current} />
          {children}
        </div>
      )}
      <footer class="foot"><div>
        cf-lite 0.4 · MIT · version 0.x, on npm. This site is built with cf-lite itself (Preact, prerendered, zero client JS on doc pages) and
        served from Workers static assets — page views never invoke the Worker.
      </div>
      <div>
        cf-lite is an independent open-source project and is not affiliated with, sponsored by, or endorsed by Cloudflare, Inc., Optimizely, or Vercel Inc. Cloudflare, Cloudflare Workers, Optimizely and Next.js are trademarks or registered trademarks of their respective owners, used here only to describe compatibility.
      </div></footer>
    </>
  );
}
