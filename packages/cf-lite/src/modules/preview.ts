/**
 * `/__preview` runtime (docs/preview.md): dev-only pattern/state browser. The generated `.cf-lite/preview.ts` calls `createPreview(...)`;
 * the generated app loads it behind `import.meta.env.DEV`, so a production Worker never contains it.
 *
 *   /__preview                          index UI (sidebar, viewport toggles, deep links via ?c=<id>&s=<state>&vp=<px|full>&tab=preview|html)
 *   /__preview/frame/<id>?s=<state>     one state as a full HTML document (shell + styles + islands); `&fragment=1` = only the component's HTML
 *   /__preview/api/manifest             JSON: components, their state names, mocks (used by the UI and by `cfl export`)
 */
import type { Context } from "hono";
import type { UiServer } from "../adapter.js";
import type { StatesDef } from "../preview.js";
import { installMocks, type MockTable } from "./mock.js";

export interface PreviewItem {
  id: string;
  name: string;
  group: string;
  island: boolean;
  /** Component module (absent when the states file names the component itself). */
  load?: () => Promise<Record<string, unknown>>;
  /** `*.states.ts` module. */
  states?: () => Promise<Record<string, unknown>>;
}
export interface PreviewOptions {
  ui: Pick<UiServer, "render"> & { bind?: UiServer["bind"] };
  items: PreviewItem[];
  /** `app/preview.setup.ts` (side-effect module: global CSS, fonts...), loaded by every frame. */
  setup?: string;
  /** Island runtime in dev: a virtual module that hydrates `<cfl-island>`s. */
  islands?: boolean;
  /** The mock table, when the project has a `mocks/` folder. */
  mocks?: () => Promise<MockTable>;
  /** Whether `MOCK=1` was set for this dev server. */
  mockOn?: boolean;
}

export const PREVIEW_PREFIX = "/__preview";
export const VIEWPORTS = [{ name: "Mobile", width: 375 }, { name: "Tablet", width: 768 }, { name: "Laptop", width: 1280 }] as const;
const SCRIPTS = /<script type="module"[^>]*><\/script>|<link rel="modulepreload"[^>]*>/g;
const ISLANDS_URL = "/@id/__x00__virtual:cf-lite-islands";

interface Loaded { component: unknown; states: Record<string, unknown>; title?: string }
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v, null, 2) + "\n", { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const text = (s: string, status: number) => new Response(s, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

/** Component + states of one entry. Throws a readable message when a module is missing the pieces. */
async function loadEntry(it: PreviewItem): Promise<Loaded> {
  let def: Partial<StatesDef> = {};
  if (it.states) {
    const m = await it.states();
    const d = (m.default && typeof m.default === "object" ? m.default : {}) as Partial<StatesDef>;
    def = { ...d, states: d.states ?? (m.states as StatesDef["states"] | undefined) ?? {} };
    if (!def.states || typeof def.states !== "object") throw new Error(`${it.id}: the states file must default-export defineStates(...) or export const states = {...}`);
    if (!def.component && m.component) def.component = m.component;
  }
  let component = def.component;
  if (component === undefined && it.load) component = (await it.load()).default;
  if (component === undefined) throw new Error(`${it.id}: no component - put the states file next to the component, or pass it to defineStates(Component, {...})`);
  return { component, states: def.states ?? { default: {} }, title: def.title };
}

export function createPreview(o: PreviewOptions) {
  const byId = new Map(o.items.map((i) => [i.id, i]));

  async function manifest() {
    const items = await Promise.all(o.items.map(async (it) => {
      try {
        const l = await loadEntry(it);
        return { id: it.id, name: l.title ?? it.name, group: it.group, island: it.island, states: Object.keys(l.states) };
      } catch (e) { return { id: it.id, name: it.name, group: it.group, island: it.island, states: [] as string[], error: (e as Error).message }; }
    }));
    const m = o.mocks ? await o.mocks() : null;
    return json({
      version: 1,
      viewports: VIEWPORTS,
      adapterBind: !!o.ui.bind,
      mock: { enabled: !!o.mockOn, routes: (m?.routes ?? []).map((r) => ({ method: r.method, host: r.host ?? null, pattern: r.pattern, file: r.file })) },
      items,
    });
  }

  async function frame(c: Context, id: string, state: string, fragment: boolean) {
    const it = byId.get(id);
    if (!it) return text(`preview: no component "${id}"`, 404);
    if (!o.ui.bind) return text("preview: this UI adapter has no bind() - component preview supports react, preact and vue", 501);
    if (o.mocks && o.mockOn) installMocks(await o.mocks(), new URL(c.req.url).origin);
    let html: string, head: string | undefined;
    try {
      const l = await loadEntry(it);
      if (!(state in l.states)) return text(`preview: "${id}" has no state "${state}" (have: ${Object.keys(l.states).join(", ")})`, 404);
      const raw = l.states[state];
      const props = (typeof raw === "function" ? await (raw as () => unknown)() : raw) as Record<string, unknown>;
      const r = await o.ui.render({ Page: o.ui.bind(l.component, props ?? {}), layouts: [], params: {}, hydrate: false });
      head = r.head;
      html = typeof r.body === "string" ? r.body : await new Response(r.body).text();
    } catch (e) {
      const msg = (e as Error).stack ?? String(e);
      console.error(`[cf-lite] preview ${id}/${state}:`, e);
      if (fragment) return text(`preview render error: ${(e as Error).message}`, 500);
      return new Response(`<!doctype html><meta charset=utf-8><body style="font:14px ui-monospace,monospace;padding:16px;color:#b00020"><b>${esc(id)} / ${esc(state)}</b><pre style="white-space:pre-wrap">${esc(msg)}</pre>`, { status: 500, headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (fragment) return new Response(html.endsWith("\n") ? html : html + "\n", { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    let shell = "";
    try {
      const res = await (c.env as { ASSETS: Fetcher }).ASSETS.fetch(new URL("/_shell.tpl", c.req.url));
      shell = await res.text();
    } catch { /* no shell: bare document below */ }
    const scripts = [o.setup ? `<script type="module" src="/${o.setup}"></script>` : "", o.islands ? `<script type="module" src="${ISLANDS_URL}"></script>` : ""].join("");
    const style = o.islands ? "<style>cfl-island{display:contents}</style>" : "";
    const body = `<div id="root" data-preview>${html}</div>${scripts}`;
    let doc: string;
    if (/<div id="root">\s*<\/div>/.test(shell)) {
      doc = shell.replace(SCRIPTS, "").replace(/<div id="root">\s*<\/div>/, () => body);
      doc = doc.replace("</head>", () => (head ?? "") + style + "</head>");
    } else doc = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${head ?? ""}${style}</head><body>${body}</body></html>`;
    return new Response(doc, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }

  return async function previewHandler(c: Context, next: () => Promise<void>): Promise<Response | void> {
    const url = new URL(c.req.url);
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();
    const sub = url.pathname.slice(PREVIEW_PREFIX.length).replace(/\/+$/, "");
    if (sub === "" || sub === "/_") return new Response(indexHtml(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    if (sub === "/api/manifest") return manifest();
    if (sub.startsWith("/frame/")) {
      const id = decodeURIComponent(sub.slice("/frame/".length));
      return frame(c, id, url.searchParams.get("s") ?? "default", url.searchParams.get("fragment") === "1");
    }
    return next(); // anything else under /__preview belongs to draft mode (docs/draft-mode.md) or 404s
  };
}

/** The index page: static shell + vanilla JS that reads the manifest (no framework, no build step, no CSP concerns: dev only). */
export function indexHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>cf-lite preview</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1a1a1a;--mut:#6b7280;--line:#e5e7eb;--acc:#2563eb;--side:#f8fafc}
@media(prefers-color-scheme:dark){:root{--bg:#111318;--fg:#e5e7eb;--mut:#9ca3af;--line:#262a33;--acc:#60a5fa;--side:#161922}}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 system-ui,sans-serif;background:var(--bg);color:var(--fg);display:grid;grid-template-columns:260px 1fr;height:100vh}
aside{background:var(--side);border-right:1px solid var(--line);overflow:auto;padding:12px}
aside h1{font-size:13px;margin:0 0 8px;letter-spacing:.04em;text-transform:uppercase;color:var(--mut)}
aside input{width:100%;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);margin-bottom:8px}
.g{margin:10px 0 2px;font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:.05em}
.c a,.s a{display:block;text-decoration:none;color:inherit;padding:3px 8px;border-radius:5px}
.c>a{font-weight:600}.s a{padding-left:20px;color:var(--mut)}.c a:hover,.s a:hover{background:var(--line)}
.on{background:var(--line)!important;color:var(--acc)!important}
main{display:flex;flex-direction:column;min-width:0}
.bar{display:flex;gap:8px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.bar b{margin-right:auto}button,.bar a{font:inherit;padding:4px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);cursor:pointer;text-decoration:none}
button[aria-pressed=true]{border-color:var(--acc);color:var(--acc)}
.stage{flex:1;overflow:auto;padding:16px;background:repeating-conic-gradient(var(--side) 0 25%,var(--bg) 0 50%) 0 0/16px 16px}
.tile{margin:0 auto 20px;background:#fff;border:1px solid var(--line);box-shadow:0 1px 3px rgba(0,0,0,.08);max-width:100%}
.tile h2{margin:0;padding:4px 8px;font:12px ui-monospace,monospace;background:var(--side);color:var(--mut);border-bottom:1px solid var(--line)}
iframe{display:block;width:100%;border:0;min-height:80px;background:#fff}
pre{margin:0;padding:12px;overflow:auto;background:var(--side);font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap;word-break:break-all}
.note{color:var(--mut);padding:12px}.err{color:#b00020}
.badge{font-size:11px;padding:1px 6px;border-radius:9px;border:1px solid var(--line);color:var(--mut);margin-left:6px}
</style></head><body>
<aside><h1>cf-lite preview</h1><input id="q" placeholder="Filter components" aria-label="Filter components"><nav id="nav"></nav><div class="g">Mocks</div><div id="mocks" class="note" style="padding:4px 8px"></div></aside>
<main><div class="bar"><b id="title">Select a component</b>
<span id="vps"></span><button id="tab" aria-pressed="false" title="Show the rendered HTML">HTML</button><a id="open" href="#" target="_blank" rel="noopener">Open frame</a></div>
<div class="stage" id="stage"><p class="note">Pick a component on the left. Deep links: <code>?c=&lt;id&gt;&amp;s=&lt;state&gt;&amp;vp=375|768|1280|full&amp;tab=html</code></p></div></main>
<script>
(function(){
var P="/__preview",qs=new URLSearchParams(location.search),st={c:qs.get("c"),s:qs.get("s"),vp:qs.get("vp")||"full",tab:qs.get("tab")||"preview"},M=null;
var $=function(i){return document.getElementById(i)};
function el(t,a,k){var e=document.createElement(t);for(var x in a||{})e.setAttribute(x,a[x]);(k||[]).forEach(function(n){e.append(n)});return e}
function link(){var p=new URLSearchParams();if(st.c)p.set("c",st.c);if(st.s)p.set("s",st.s);if(st.vp!=="full")p.set("vp",st.vp);if(st.tab!=="preview")p.set("tab",st.tab);return P+(p.toString()?"?"+p:"")}
function go(n){Object.assign(st,n);history.replaceState(null,"",link());draw()}
function frameUrl(id,s,f){return P+"/frame/"+id.split("/").map(encodeURIComponent).join("/")+"?s="+encodeURIComponent(s)+(f?"&fragment=1":"")}
function nav(){var q=$("q").value.toLowerCase(),box=$("nav");box.textContent="";var g="";
M.items.filter(function(i){return !q||i.id.toLowerCase().indexOf(q)>=0}).forEach(function(i){
if(i.group!==g){g=i.group;box.append(el("div",{class:"g"},[g]))}
var d=el("div",{class:"c"},[]);var a=el("a",{href:"#"},[i.name+(i.island?"":"")]);if(i.island)a.append(el("span",{class:"badge"},["island"]));
if(st.c===i.id&&!st.s)a.className="on";a.onclick=function(e){e.preventDefault();go({c:i.id,s:null})};d.append(a);
var s=el("div",{class:"s"},[]);i.states.forEach(function(n){var b=el("a",{href:"#"},[n]);if(st.c===i.id&&st.s===n)b.className="on";b.onclick=function(e){e.preventDefault();go({c:i.id,s:n})};s.append(b)});d.append(s);box.append(d)})}
function vps(){var b=$("vps");b.textContent="";[["full","Full"]].concat(M.viewports.map(function(v){return [String(v.width),v.name+" "+v.width]})).forEach(function(v){
var x=el("button",{"aria-pressed":String(st.vp===v[0])},[v[1]]);x.onclick=function(){go({vp:v[0]})};b.append(x," ")})}
function tile(i,s){var w=st.vp==="full"?"100%":st.vp+"px";var t=el("div",{class:"tile",style:"width:"+w},[el("h2",{},[i.id+" / "+s])]);
if(st.tab==="html"){var pre=el("pre",{},["loading..."]);fetch(frameUrl(i.id,s,true)).then(function(r){return r.text()}).then(function(h){pre.textContent=h});t.append(pre)}
else{var f=el("iframe",{src:frameUrl(i.id,s),title:i.id+" "+s});f.onload=function(){try{f.style.height=f.contentDocument.documentElement.scrollHeight+"px"}catch(e){}};t.append(f)}return t}
function draw(){nav();vps();$("tab").setAttribute("aria-pressed",String(st.tab==="html"));var stage=$("stage");stage.textContent="";
var i=M.items.filter(function(x){return x.id===st.c})[0];if(!i){$("title").textContent="Select a component";$("open").style.visibility="hidden";stage.append(el("p",{class:"note"},[M.items.length?"Pick a component on the left.":"No components found. Add app/components/Name.tsx or Name.states.ts."]));return}
$("title").textContent=i.name+(st.s?" / "+st.s:"");if(i.error){stage.append(el("pre",{class:"err"},[i.error]));return}
var o=$("open");o.style.visibility="visible";o.href=frameUrl(i.id,st.s||i.states[0]||"default");
(st.s?[st.s]:i.states).forEach(function(s){stage.append(tile(i,s))})}
$("tab").onclick=function(){go({tab:st.tab==="html"?"preview":"html"})};$("q").oninput=function(){nav()};
fetch(P+"/api/manifest").then(function(r){return r.json()}).then(function(m){M=m;
var mk=$("mocks");if(m.mock.routes.length){mk.textContent=(m.mock.enabled?"MOCK=1 on":"MOCK=1 off (set it to serve these)")+": "+m.mock.routes.map(function(r){return r.method+" "+(r.host||"")+r.pattern}).join(", ")}else mk.textContent="none (mocks/ folder)";
draw();if(!m.adapterBind)$("stage").append(el("p",{class:"note err"},["This UI adapter cannot render components in preview (react, preact, vue can)."]))});
})();
</script></body></html>`;
}
