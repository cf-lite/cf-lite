import { createComponent, mergeProps, splitProps, type JSX } from "solid-js";
import { Dynamic } from "solid-js/web";
import { imageAttrs, type ImageProps } from "cf-lite/modules/images";

export { configureImages } from "cf-lite/modules/images";
export type { ImagesConfig } from "cf-lite/modules/images";

/** `<Image src width height sizes priority />`: srcset + intrinsic dimensions (no layout shift) + loading/fetchpriority. docs/images.md */
export function Image(props: ImageProps & Omit<JSX.ImgHTMLAttributes<HTMLImageElement>, "src" | "width" | "height" | "sizes" | "alt" | "loading">) {
  const [own, rest] = splitProps(props, ["src", "alt", "width", "height", "sizes", "priority", "quality", "fill", "blurDataURL", "unoptimized", "config"]);
  // Dynamic takes flat props: expand the computed attributes through getters so they stay reactive.
  return createComponent(Dynamic as never, mergeProps(rest, { component: "img" }, {
    get src() { return imageAttrs(own).src; }, get srcset() { return imageAttrs(own).srcset; }, get sizes() { return imageAttrs(own).sizes; },
    get alt() { return imageAttrs(own).alt; }, get width() { return imageAttrs(own).width; }, get height() { return imageAttrs(own).height; },
    get loading() { return imageAttrs(own).loading; }, get decoding() { return imageAttrs(own).decoding; },
    get fetchpriority() { return imageAttrs(own).fetchpriority; }, get style() { return imageAttrs(own).style; },
  }) as never);
}
