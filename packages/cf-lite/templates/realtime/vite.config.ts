import { defineConfig } from "vite";
import cfLite from "cf-lite/vite";

export default defineConfig({ plugins: [cfLite()] });
