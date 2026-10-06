/**
 * Built-in presets for `cf-lite add <name>` / `create-cf-lite --ui <name>` that are NOT a UI adapter: no package, no renderer, no
 * component model. `renderer` stays "none"; the preset only drops starter files and dependencies into the app.
 *
 * htmx + Alpine: the server renders HTML fragments from plain Hono routes (`server/api/ui.ts`, `hono/html` escapes by default),
 * htmx swaps them in through `hx-*` attributes and Alpine adds small client-side state (`x-data`). No JSX, no component compiler,
 * no virtual DOM: the only build step is Vite bundling two small libraries from `app/main.ts`.
 */
import type { AdapterScaffold } from "./adapter.js";

export const HTMX_SERVER = `import { Hono } from "hono";
import { html } from "hono/html";

// Server-rendered fragments. \`html\` escapes interpolated values; state travels in the request (hx-vals), so the Worker stays stateless.
const counter = (n: number) => html\`<div id="counter">
  <button hx-post="/api/ui/count" hx-vals='{"n": \${n + 1}}' hx-target="#counter" hx-swap="outerHTML">clicked \${n}</button>
</div>\`;

export default new Hono<{ Bindings: Env }>()
  .get("/", (c) => c.html(html\`<main>
  <h1>Hello from cf-lite + htmx</h1>
  \${counter(0)}
  <div x-data="{ open: false }">
    <button @click="open = !open" x-text="open ? 'hide' : 'show'"></button>
    <p x-show="open" style="display:none">Alpine: client-side state, no build step.</p>
  </div>
  <p><a href="#" hx-get="/api/ui/time" hx-target="#time" hx-swap="innerHTML">what time is it?</a> <span id="time"></span></p>
</main>\`))
  .post("/count", async (c) => c.html(counter(Number((await c.req.parseBody()).n) || 0)))
  .get("/time", (c) => c.html(html\`<time>\${new Date().toISOString()}</time>\`));
`;

export const HTMX_MAIN = `import htmx from "htmx.org";
import Alpine from "alpinejs";

(window as unknown as { htmx: typeof htmx }).htmx = htmx; // htmx attaches to window for hx-on / extensions
(window as unknown as { Alpine: typeof Alpine }).Alpine = Alpine;
Alpine.start();
`;

export const PRESETS: Record<string, AdapterScaffold> = {
  htmx: {
    deps: { "htmx.org": "^2.0.11", alpinejs: "^3.17.4" },
    devDeps: { "@types/alpinejs": "^3.13.11" },
    entry: { file: "app/main.ts", content: HTMX_MAIN },
    starter: { "server/api/ui.ts": HTMX_SERVER },
    rootAttrs: 'hx-get="/api/ui" hx-trigger="load" hx-swap="innerHTML"',
  },
};
export const isPreset = (ui: string) => Object.hasOwn(PRESETS, ui);
