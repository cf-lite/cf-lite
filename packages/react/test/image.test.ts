import { expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Image } from "../src/image.js";

it("renders srcset + intrinsic dimensions + priority hints", () => {
  const html = renderToStaticMarkup(createElement(Image, { src: "/a.jpg", alt: "A", width: 640, height: 320, sizes: "100vw", priority: true, config: { widths: [320, 640] } }));
  expect(html).toContain('width="640"'); expect(html).toContain('height="320"'); expect(html).toContain('loading="eager"'); expect(html).toContain('fetchPriority="high"');
  expect(html).toContain('srcSet="/_img?src=%2Fa.jpg&amp;w=320&amp;q=75 320w, /_img?src=%2Fa.jpg&amp;w=640&amp;q=75 640w"');
});
it("fill maps style; blur placeholder", () => {
  const html = renderToStaticMarkup(createElement(Image, { src: "/a.jpg", fill: true, blurDataURL: "data:image/png;base64,AAA" }));
  expect(html).toContain("position:absolute"); expect(html).toContain("background-size:cover"); expect(html).not.toContain("width=");
});
