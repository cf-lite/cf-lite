import { expect, it } from "vitest";
import { h } from "preact";
import { renderToString } from "preact-render-to-string";
import { Image } from "../src/image.js";

it("renders srcset + intrinsic dimensions + priority hints", () => {
  const html = renderToString(h(Image, { src: "/a.jpg", alt: "A", width: 640, height: 320, sizes: "100vw", priority: true, config: { widths: [320, 640] } }));
  expect(html).toContain('width="640"'); expect(html).toContain('height="320"'); expect(html).toContain('loading="eager"'); expect(html).toContain('fetchpriority="high"');
  expect(html).toContain('srcset="/_img?src=%2Fa.jpg&amp;w=320&amp;q=75 320w, /_img?src=%2Fa.jpg&amp;w=640&amp;q=75 640w"');
});
