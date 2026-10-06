import preact from "@preact/preset-vite";
import { defineAdapter } from "cf-lite/adapter";

export interface PreactOptions {
  /** Alias react / react-dom to preact/compat so react-flavoured code and libraries work (default true). */
  compat?: boolean;
}

/** `cfLite({ renderer: preact() })` - native Preact: sequential streaming SSR, hydrate, prefresh HMR. */
export default function preactAdapter(options: PreactOptions = {}) {
  const compat = options.compat !== false;
  return defineAdapter({
    id: "@cf-lite/preact",
    options: { compat },
    extensions: [".tsx", ".jsx", ".ts", ".js"],
    client: "@cf-lite/preact/client",
    server: "@cf-lite/preact/server",
    islands: { wrap: "@cf-lite/preact/islands", mount: "@cf-lite/preact/islands-client" },
    vite: () => ({ plugins: [preact({ reactAliasesEnabled: compat })] }),
  });
}
export { preactAdapter as preact };
