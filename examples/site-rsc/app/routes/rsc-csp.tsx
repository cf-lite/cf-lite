// Under `security({ preset: "strict" })` (server/middleware.ts): nonce on bootstrap + inline Flight scripts, island still hydrates.
import { Suspense } from "react";
import { Counter } from "../islands/counter";

export const render = "rsc";
export const head = { script: [{ content: "window.__headRan=1", strategy: "blocking" as const }] }; // head scripts get the nonce too
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function Slow() { await sleep(40); return <p id="slow">slow under csp</p>; }

export default function Page() {
  return <main><h1 id="mode">csp page</h1><Counter label="clicks" /><Suspense fallback={<p id="slow-fallback">loading</p>}><Slow /></Suspense></main>;
}
