// Static "/" beside SPA routes: prerendered, zero JS.
export const render = "static";
export const head = { title: "Home — site", meta: [{ name: "description", content: "static home" }] };

export default function Home() {
  return <main><h1 data-testid="h">Home (static)</h1></main>;
}
