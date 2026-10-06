import { defineConfig } from "vite";
import cfLite from "cf-lite/vite";
import react from "@cf-lite/react";

// No `*.island.tsx` anywhere: `islands.auto` makes the interactive components in app/components islands (docs/islands.md#auto-islands). Strict CSP on purpose, as in site-islands.
export default defineConfig({ plugins: [cfLite({ renderer: react(), security: { preset: "strict" }, islands: { auto: true } })] });
