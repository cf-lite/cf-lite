import ProductCard, { type Product } from "../../molecules/ProductCard/ProductCard";

export default function ProductGrid({ products }: { products: Product[] }) {
  if (!products.length) return <p data-testid="empty">Nothing here yet.</p>;
  return <section className="grid">{products.map((p) => <ProductCard key={p.id} product={p} />)}</section>;
}
