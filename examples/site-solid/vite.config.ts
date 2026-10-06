import { defineConfig } from "vite";
import cfLite from "cf-lite/vite";
import solid from "@cf-lite/solid";

export default defineConfig({ plugins: [cfLite({ renderer: solid() })] });
