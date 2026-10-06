import { h, type JSX } from "preact";
import { imageAttrs, type ImageProps } from "cf-lite/modules/images";

export { configureImages } from "cf-lite/modules/images";
export type { ImagesConfig } from "cf-lite/modules/images";

/** `<Image src width height sizes priority />`: srcset + intrinsic dimensions (no layout shift) + loading/fetchpriority. docs/images.md */
export function Image({ src, width, height, sizes, priority, quality, fill, blurDataURL, unoptimized, config, alt, style, ...rest }:
  ImageProps & Omit<JSX.HTMLAttributes<HTMLImageElement>, "src" | "width" | "height" | "sizes" | "alt" | "loading" | "style"> & { style?: Record<string, string> }) {
  const { srcset, fetchpriority, style: css, ...a } = imageAttrs({ src, width, height, sizes, priority, quality, fill, blurDataURL, unoptimized, config, alt });
  return h("img", { ...rest, ...a, srcset, fetchpriority, style: css || style ? { ...css, ...style } : undefined } as never);
}
