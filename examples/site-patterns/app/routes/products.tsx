import ProductGrid from "@patterns/organisms/ProductGrid/ProductGrid";
import type { Product } from "@patterns/molecules/ProductCard/ProductCard";
import Counter from "@/islands/Counter.island";

export const render = "ssr";
export const head = { title: "Products" };

// Same code in dev with MOCK=1 (served from mocks/) and in production (the real backend): only the origin's mocks/ folder differs.
export async function loader(c: { req: { url: string } }): Promise<{ products: Product[] }> {
  const res = await fetch(new URL("/api/products", c.req.url));
  return { products: res.ok ? ((await res.json()) as Product[]) : [] };
}

export default function Products({ data }: { data?: { products: Product[] } }) {
  return <main><h1>Products</h1><ProductGrid products={data?.products ?? []} /><Counter start={1} /></main>;
}
