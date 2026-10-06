import Button from "@patterns/atoms/Button/Button";

export interface Product { id: number; name: string; price: number }

export default function ProductCard({ product, soldOut = false }: { product: Product; soldOut?: boolean }) {
  return (
    <article className="card" data-testid="product-card">
      <h3>{product.name}</h3>
      <p>${product.price.toFixed(2)}</p>
      <Button label={soldOut ? "Sold out" : "Add to cart"} disabled={soldOut} />
    </article>
  );
}
