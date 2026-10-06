import { defineConfig } from "vite";
import cfLite from "cf-lite/vite";
import react from "@cf-lite/react";

export default defineConfig({ plugins: [cfLite({ renderer: react(), security: { preset: "strict" } })] });
