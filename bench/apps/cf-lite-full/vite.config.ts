import { defineConfig } from "vite";
import cfLite from "cf-lite/vite";
import react from "@cf-lite/react";
// "Realistic app" variant: strict security headers (static pages get them from the generated `_headers`, Worker responses from security()).
export default defineConfig({ plugins: [cfLite({ renderer: react(), security: { preset: "strict" } })] });
