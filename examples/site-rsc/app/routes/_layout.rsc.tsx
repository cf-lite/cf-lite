// Server layout shared by every render = "rsc" route (docs/design/rsc.md). Server-safe: no hooks, no client Link.
import type { ReactNode } from "react";

export const head = { meta: [{ name: "description", content: "rsc layout default" }, { name: "robots", content: "index" }] };

export default function RscRoot({ children }: { children?: ReactNode }) {
  return <div data-testid="rsc-root"><header id="rsc-nav"><a id="l-rsc" href="/rsc">rsc</a> · <a id="l-data" href="/rsc-data">data</a> · <a id="l-form" href="/rsc-form">form</a> · <a id="l-other" href="/rsc-other">other</a> · <a id="l-tall" href="/rsc-tall">tall</a> · <a id="l-pure" href="/rsc-pure">pure</a> · <a id="l-about" href="/about">about (spa)</a></header>{children}</div>;
}
