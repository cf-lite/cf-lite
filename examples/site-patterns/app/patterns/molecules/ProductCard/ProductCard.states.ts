import { defineStates } from "cf-lite/preview";
import ProductCard from "./ProductCard";
import products from "../../../../mocks/api/products.json"; // the same JSON the MOCK=1 route /api/products serves

export default defineStates(ProductCard, {
  default: { product: products[0]! },
  "sold-out": { product: products[1]!, soldOut: true },
  // a state can compute its props (sync or async)
  expensive: () => ({ product: { id: 99, name: "Limited edition", price: 1999 } }),
});
