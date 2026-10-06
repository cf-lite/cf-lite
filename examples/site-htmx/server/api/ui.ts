import { Hono } from "hono";
import { html } from "hono/html";

// The whole UI is server-rendered fragments (hono/html escapes every interpolation); htmx swaps them in, Alpine holds the small client state.
const nav = html`<nav>
  ${[["home", "Home"], ["about", "About"], ["dashboard", "Dashboard"], ["blog/hello", "Blog"]].map(
    ([p, l]) => html`<a href="#" hx-get="/api/ui/page/${p}" hx-target="#view" data-testid="nav-${l.toLowerCase()}">${l}</a> `)}
</nav>`;

const counter = (n: number) => html`<div id="counter">
  <button data-testid="inc" hx-post="/api/ui/count" hx-vals='{"n": ${n + 1}}' hx-target="#counter" hx-swap="outerHTML">clicked ${n}</button>
</div>`;

const pages: Record<string, () => unknown> = {
  home: () => html`<main><h1 data-testid="h">Home</h1></main>`,
  about: () => html`<main><h1 data-testid="h">About</h1></main>`,
  dashboard: () => html`<main>
  <h1 data-testid="h">Dashboard</h1>
  ${counter(0)}
  <div x-data="{ open: false }">
    <button data-testid="toggle" @click="open = !open" x-text="open ? 'hide' : 'show'"></button>
    <p data-testid="alpine" x-show="open" style="display:none">Alpine: client-side state, no build step.</p>
  </div>
  <button data-testid="rpc" hx-get="/api/hello" hx-target="#rpc-out" hx-swap="innerHTML">rpc</button><span id="rpc-out" data-testid="rpc-out"></span>
</main>`,
};

export default new Hono<{ Bindings: Env }>()
  .get("/", (c) => c.html(html`<div data-testid="l-root">${nav}<div id="view">${pages.home()}</div></div>`))
  .get("/page/blog/:slug", (c) => c.html(html`<article data-testid="l-blog"><main><h1 data-testid="h">Blog ${c.req.param("slug")}</h1><p data-testid="at">${new Date().toISOString()}</p></main></article>`))
  .get("/page/:name", (c) => { const p = pages[c.req.param("name")]; return p ? c.html(p() as never) : c.notFound(); })
  .post("/count", async (c) => c.html(counter(Number((await c.req.parseBody()).n) || 0)));
