import { defineConfig } from "vite";
import cfLite from "cf-lite/vite";
import react from "@cf-lite/react";

// The `@/*` and `@patterns/*` aliases come from tsconfig.json `paths`: cfLite() mirrors them into Vite (aliases: false opts out).
export default defineConfig({ plugins: [cfLite({ renderer: react() })] });
