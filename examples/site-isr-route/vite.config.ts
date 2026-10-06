import { defineConfig } from "vite";
import cfLite from "cf-lite/vite";
import preact from "@cf-lite/preact";

export default defineConfig({ plugins: [cfLite({ renderer: preact() })] });
