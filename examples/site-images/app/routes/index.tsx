import { Image } from "@cf-lite/react/image";
import { imagesConfig } from "../images";

// SSR (not prerendered) so the page always reflects the config; `<Image>` emits srcset + width/height, so there is no layout shift.
export const render = "ssr";
export const head = { title: "Images — site-images" };

export default function Home() {
  return (
    <main>
      <h1>Images</h1>
      <Image src="/img/hero.png" alt="hero" width={1600} height={800} sizes="(min-width: 800px) 800px, 100vw" priority config={imagesConfig} data-testid="hero" style={{ maxWidth: "100%", height: "auto" }} />
      <p>Below the fold</p>
      <div style={{ height: 2000 }} />
      <Image src="/img/hero.png" alt="lazy" width={1600} height={800} config={imagesConfig} data-testid="lazy" style={{ maxWidth: "100%", height: "auto" }} />
    </main>
  );
}
