// render = "rsc": React Server Components (opt-in, docs/design/rsc.md). Async server component + "use client" island + streaming.
import { Suspense } from "react";
import { Counter } from "../islands/counter";

export const render = "rsc";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function Slow({ ms }: { ms: number }) { await sleep(ms); return <p id="slow">slow data after {ms}ms</p>; }
async function Fast() { const items = await Promise.resolve(["alpha", "beta", "gamma"]); return <ul id="fast">{items.map((i) => <li key={i}>{i}</li>)}</ul>; }

export default function Page({ url }: { params: Record<string, string>; url: string }) {
  const ms = Number(new URL(url).searchParams.get("ms") ?? 150);
  return <main><h1 id="mode">rendered by: rsc (cf-lite)</h1><Fast /><Counter label="clicks" /><Suspense fallback={<p id="slow-fallback">loading…</p>}><Slow ms={ms} /></Suspense></main>;
}
