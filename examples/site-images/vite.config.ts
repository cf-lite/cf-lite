import { defineConfig } from "vite";
import cfLite from "cf-lite/vite";
import react from "@cf-lite/react";
import { images } from "cf-lite/conventions/images";
import { imagesConfig } from "./app/images.ts";

export default defineConfig({ plugins: [cfLite({ renderer: react(), conventions: [images(imagesConfig)] })] });
