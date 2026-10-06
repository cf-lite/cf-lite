// render = "rsc" + loader + bindings + cache with tags: the HTML (with its inline Flight payload) is one cache entry.
import { Suspense } from "react";
import { getRequest, getEnv } from "cf-lite/rsc";

export const render = "rsc";
export const cache = ({ data }: { data: unknown }) => ({ maxAge: 60, swr: 60, tags: ["rsc", `rsc:${(data as { id: string }).id}`] });
export const head = ({ data }: { data: unknown }) => ({ title: `data ${(data as { id: string }).id}`, meta: [{ property: "og:title", content: "rsc data" }] });

let renders = 0; // module state per isolate: proves HIT/MISS in the e2e (the body shows how many times this isolate rendered)
export async function loader({ env, params, url }: { env: unknown; params: Record<string, string>; url: URL }) {
  return { id: url.searchParams.get("id") ?? "1", greeting: (env as { GREETING?: string }).GREETING ?? "hi", ...params };
}

async function FromContext() {
  await Promise.resolve();
  const { env, url, data } = getRequest();
  return <p id="ctx">{getEnv<{ GREETING?: string }>().GREETING} {url.pathname} {(data as { id: string }).id} {String(env !== undefined)}</p>;
}
async function Slow() { await new Promise((r) => setTimeout(r, 30)); return <p id="slow">slow done</p>; }

export default function Page({ data }: { data: { id: string; greeting: string } }) {
  renders++;
  return <main><h1 id="mode">data {data.id} / {data.greeting}</h1><p id="renders">renders:{renders}</p><FromContext /><Suspense fallback={<p id="fb">loading</p>}><Slow /></Suspense></main>;
}
