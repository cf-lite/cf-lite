import { defineConfig } from "vite";
import cfLite from "cf-lite/vite";
import svelte from "@cf-lite/svelte";

export default defineConfig({ plugins: [cfLite({ renderer: svelte() })] });
