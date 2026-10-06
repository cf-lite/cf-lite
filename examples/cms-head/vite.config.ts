import { defineConfig } from "vite";
import cfLite from "cf-lite/vite";
import react from "@cf-lite/react";

// draft: true = draft() + /api/draft/{enable,disable} (docs/draft-mode.md)
export default defineConfig({ plugins: [cfLite({ renderer: react(), draft: true })] });
