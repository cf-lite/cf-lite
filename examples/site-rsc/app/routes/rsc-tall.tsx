// P3: tall page for scroll restoration; the link at the bottom is far below the fold.
export const render = "rsc";
export const head = { title: "tall" };

export default function Page() {
  return <main><h1 id="mode">tall</h1><div style={{ height: 3000 }} /><a id="bottom-link" href="/rsc-other">to other</a><a id="vp-link" data-prefetch="viewport" href="/rsc-data?id=vp">viewport-prefetched</a></main>;
}
