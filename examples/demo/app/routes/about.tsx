// Prerendered at build time to dist/client/about/index.html. Ships zero JS (no `hydrate`).
export const render = "static";
export const head = { title: "About — cf-lite", meta: [{ name: "description", content: "Prerendered at build time" }] };

export default function About() {
  return (
    <main>
      <h1>About</h1>
      <p>This page was rendered once, at build time. No Worker invocation, no client JS.</p>
      <a href="/">home</a>
    </main>
  );
}
