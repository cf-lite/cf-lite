import { Shell, pages } from "../components/Shell";

export const render = "static";
export const head: { title: string; meta: Record<string, string>[] } = {
  title: "cf-lite — a Cloudflare-only web framework-lite",
  meta: [
    { name: "description", content: "Vite + Hono + Workers static assets. File conventions generated at build time; static traffic never wakes the Worker." },
    { property: "og:type", content: "website" },
    { property: "og:site_name", content: "cf-lite docs" },
    { property: "og:title", content: "cf-lite — a Cloudflare-only web framework-lite" },
    { property: "og:description", content: "Vite + Hono + Workers static assets. No framework runtime between your code and workerd." },
    { name: "twitter:card", content: "summary" },
  ],
};

const blurbs: Record<string, string> = {
  "getting-started": "Scaffold, pick a UI, deploy.", design: "Request flow, render modes, what is left out.", adapters: "React, Preact, Vue, Svelte, htmx.",
  benchmarks: "Size, CPU and cold start — with the caveats.", "field-notes": "What broke in real use and how it was fixed.", upgrading: "Breaking changes between 0.x.", changelog: "Release history.",
};

export default function Home() {
  return (
    <Shell bare>
      <main id="main">
        <section class="hero">
          <h1>A web framework-lite for <em>Cloudflare</em> only.</h1>
          <p>Vite + Hono + Workers static assets, with file-based conventions compiled at build time. No framework runtime between your code and workerd — and static pages never wake the Worker.</p>
          <div class="btns"><a class="btn pri" href="/docs/getting-started/">Get started</a><a class="btn sec" href="/docs/design/">Read the design</a></div>
        </section>
        <section class="facts" aria-label="Key facts">
          <div class="fact"><b>0 ms</b><span>Worker CPU for static pages and redirects — the assets layer answers, nothing is invoked.</span></div>
          <div class="fact"><b>7–74 KiB</b><span>Worker size (gzip), from an API-only app to a React SSR app.</span></div>
          <div class="fact"><b>5 UIs</b><span>React, Preact, Vue, Svelte or htmx/Alpine — one small adapter each.</span></div>
        </section>
        <div class="home-cols">
          <section>
            <h2>Three page kinds per route</h2>
            <p><b>SPA</b> by default, <b>static</b> (<code>export const render = "static"</code>) prerendered with zero JS, or <b>SSR</b> streamed from the Worker with optional hydration. This very site is 100% static pages.</p>
            <p>Honest about limits: it is 0.x, Cloudflare-only, has no ISR, and a prerendered page is <a href="/docs/benchmarks/">not faster</a> than a trivial Worker on the wire — the case is size, CPU and cold start.</p>
          </section>
          <section>
            <h2>Documentation</h2>
            <ul class="cards">{pages.map((p) => <li><a href={`/docs/${p.slug}/`}>{p.title}<small>{blurbs[p.slug]}</small></a></li>)}</ul>
          </section>
        </div>
      </main>
    </Shell>
  );
}
