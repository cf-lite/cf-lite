import solid from "vite-plugin-solid";
import { defineAdapter } from "cf-lite/adapter";

/** `cfLite({ renderer: solid() })` - Solid 1.9: streaming SSR (`renderToStream`), fine-grained hydration, Solid's own HMR. Routes are `.tsx`/`.jsx`. */
export default function solidAdapter() {
  return defineAdapter({
    id: "@cf-lite/solid",
    extensions: [".tsx", ".jsx", ".ts", ".js"],
    client: "@cf-lite/solid/client",
    server: "@cf-lite/solid/server",
    vite: () => ({ plugins: [solid({ ssr: true })] }),
  });
}
export { solidAdapter as solid };
