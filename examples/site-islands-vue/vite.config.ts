import { defineConfig } from "vite";
import cfLite from "cf-lite/vite";
import vue from "@cf-lite/vue";

export default defineConfig({ plugins: [cfLite({ renderer: vue() })] });
