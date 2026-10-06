import { defineStates } from "cf-lite/preview";
import ProductGrid from "./ProductGrid";
import products from "../../../../mocks/api/products.json";

export default defineStates(ProductGrid, { default: { products }, empty: { products: [] } });
