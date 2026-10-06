import { defineConfig } from "vite";
import cfLite from "cf-lite/vite";
import react from "@cf-lite/react";

export default defineConfig({
  plugins: [cfLite({
    renderer: react(),
    // Path-prefix locales: pages live under app/routes/[locale]/. Only `/` and unprefixed paths wake the Worker (Accept-Language / cookie / country).
    i18n: { locales: ["en", "vi"], default: "en", /* countries: { VN: "vi" } - optional request.cf.country fallback */ },
  })],
});
