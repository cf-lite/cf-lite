import type { ImagesConfig } from "@cf-lite/react/image";

/** One config for both sides: `<Image config>` (URLs) and `images(imagesConfig)` in vite.config.ts (the /_img route). */
export const imagesConfig: ImagesConfig = { backend: "binding", widths: [320, 640, 800, 1600], allowHosts: ["images.example.com"] };
