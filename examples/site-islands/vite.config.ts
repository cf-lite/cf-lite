import { defineConfig } from "vite";
import cfLite from "cf-lite/vite";
import react from "@cf-lite/react";

// strict CSP on purpose: islands must hydrate under it (static pages: hashes in _headers; SSR pages: per-request nonce)
export default defineConfig({ plugins: [cfLite({ renderer: react(), security: { preset: "strict" }, islands: { runtime: process.env.ISLANDS_RUNTIME === "preact" ? "preact" : "react" } })] });
