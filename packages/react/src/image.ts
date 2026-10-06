import { createElement, type ImgHTMLAttributes } from "react";
import { imageAttrs, type ImageProps } from "cf-lite/modules/images";

export { configureImages } from "cf-lite/modules/images";
export type { ImagesConfig } from "cf-lite/modules/images";

/** `<Image src width height sizes priority />`: srcset + intrinsic dimensions (no layout shift) + loading/fetchpriority. docs/images.md */
export function Image({ src, width, height, sizes, priority, quality, fill, blurDataURL, unoptimized, config, alt, style, ...rest }:
  ImageProps & Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "width" | "height" | "sizes" | "alt" | "loading">) {
  const { srcset, fetchpriority, style: css, ...a } = imageAttrs({ src, width, height, sizes, priority, quality, fill, blurDataURL, unoptimized, config, alt });
  const base = css && Object.fromEntries(Object.entries(css).map(([k, v]) => [k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()), v]));
  return createElement("img", { ...rest, ...a, srcSet: srcset, fetchPriority: fetchpriority, style: base || style ? { ...base, ...style } : undefined });
}
