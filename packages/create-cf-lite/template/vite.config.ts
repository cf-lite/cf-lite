import { defineConfig } from "vite";
import cfLite from "cf-lite/vite";

// renderer defaults to "none" (API + your own index.html). `npx cf-lite add react|preact|vue|svelte` sets it for you.
export default defineConfig({ plugins: [cfLite()] });
