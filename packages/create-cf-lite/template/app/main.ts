// cf-lite:none-starter (deleted by `cf-lite add <ui>`)
// renderer "none": no UI framework. Plain DOM + a typed call to the Hono API in server/api/hello.ts.
import { hc } from "hono/client";
import type { ApiType } from "../.cf-lite/app";

const api = hc<ApiType>("/api");
const root = document.getElementById("root")!;
root.innerHTML = "<h1>cf-lite</h1><p id=msg>…</p><p>Add a UI: <code>npx cf-lite add react|preact|vue|svelte</code></p>";
api.hello.$get().then((r) => r.json()).then((j) => (document.getElementById("msg")!.textContent = j.message));
