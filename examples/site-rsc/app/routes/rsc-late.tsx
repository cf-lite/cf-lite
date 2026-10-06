// notFound() / redirect() after the shell flushed: the status is already 200, the generated boundary degrades it client-side.
import { Suspense } from "react";
import { notFound, redirect } from "cf-lite/rsc";
export const render = "rsc";
async function Late({ mode }: { mode: string }): Promise<never> { await new Promise((r) => setTimeout(r, 40)); if (mode === "redirect") redirect("/rsc-data?id=late"); notFound(); }
export default function Page({ url }: { url: string }) {
  const mode = new URL(url).searchParams.get("mode") ?? "nf";
  return <main><h1 id="late-shell">late shell</h1><Suspense fallback={<p id="late-fb">waiting</p>}><Late mode={mode} /></Suspense></main>;
}
