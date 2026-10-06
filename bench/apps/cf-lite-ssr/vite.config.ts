import { defineConfig } from "vite";
import cfLite from "cf-lite/vite";
import react from "@cf-lite/react";
import preact from "@cf-lite/preact";
// same app, two renderers: CF_LITE_RENDERER=preact -> @cf-lite/preact (native preact + react->compat aliases)
export default defineConfig({ plugins: [cfLite({ renderer: process.env.CF_LITE_RENDERER === "preact" ? preact() : react() })] });
