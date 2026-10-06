import { defineComponent, h, type PropType } from "vue";
import { imageAttrs, type ImagesConfig } from "cf-lite/modules/images";

export { configureImages } from "cf-lite/modules/images";
export type { ImagesConfig } from "cf-lite/modules/images";

/** `<Image src width height sizes priority />`: srcset + intrinsic dimensions (no layout shift) + loading/fetchpriority. docs/images.md */
export const Image = defineComponent({
  name: "CfImage",
  inheritAttrs: false,
  props: {
    src: { type: String, required: true }, alt: String, width: Number, height: Number, sizes: String, quality: Number,
    priority: Boolean, fill: Boolean, unoptimized: Boolean, blurDataURL: String, config: Object as PropType<ImagesConfig>,
  },
  setup(props, { attrs }) {
    return () => h("img", { ...attrs, ...imageAttrs({ ...props }) });
  },
});
