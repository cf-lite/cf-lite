<script>
  import { imageAttrs, cssText } from "cf-lite/modules/images";
  let { src, alt = "", width, height, sizes, priority, quality, fill, blurDataURL, unoptimized, config, ...rest } = $props();
  const a = $derived(imageAttrs({ src, alt, width, height, sizes, priority, quality, fill, blurDataURL, unoptimized, config }));
</script>

<img {...rest} src={a.src} srcset={a.srcset} sizes={a.sizes} {alt} width={a.width} height={a.height} loading={a.loading} decoding={a.decoding} fetchpriority={a.fetchpriority} style={a.style ? cssText(a.style) : undefined} />
