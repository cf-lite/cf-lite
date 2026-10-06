import { defineConfig } from "vite";
import cfLite from "cf-lite/vite";
import preact from "@cf-lite/preact";

// draft: true = draft() + /api/draft/* + /__preview/* for the prerendered pages (docs/draft-mode.md)
export default defineConfig({ plugins: [cfLite({ renderer: preact(), draft: { frameAncestors: ["https://cms.example.com"] } })] });
