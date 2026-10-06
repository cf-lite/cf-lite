import Button from "@patterns/atoms/Button/Button";

// A static (prerendered) page that imports through a tsconfig alias: the build and the prerender server must both resolve it.
export const render = "static";
export const head = { title: "Patterns demo" };

export default function Home() {
  return <main><h1>Patterns demo</h1><p>Open <a href="/__preview">/__preview</a> (dev server only). Start with <code>MOCK=1 cf-lite dev</code> to see <a href="/products">/products</a> served from <code>mocks/</code>.</p><Button label="Add to cart" /></main>;
}
