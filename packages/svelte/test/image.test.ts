import { expect, it } from "vitest";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { compile } from "svelte/compiler";
import { render } from "svelte/server";

it("renders srcset + intrinsic dimensions + priority hints (server compile)", async () => {
  const src = readFileSync(new URL("../lib/Image.svelte", import.meta.url), "utf8");
  const out = compile(src, { generate: "server", filename: "Image.svelte" }).js.code;
  const file = new URL("./.Image.compiled.mjs", import.meta.url);
  writeFileSync(file, out);
  try {
    const { default: Image } = await import(file.href);
    const { body } = render(Image, { props: { src: "/a.jpg", alt: "A", width: 640, height: 320, sizes: "100vw", priority: true, config: { widths: [320, 640] } } });
    expect(body).toContain('width="640"'); expect(body).toContain('height="320"'); expect(body).toContain('loading="eager"'); expect(body).toContain('fetchpriority="high"');
    expect(body).toContain('srcset="/_img?src=%2Fa.jpg&amp;w=320&amp;q=75 320w, /_img?src=%2Fa.jpg&amp;w=640&amp;q=75 640w"');
  } finally { rmSync(file, { force: true }); }
});
