import type { ComponentChildren } from "preact";

export default function BlogLayout({ children }: { children?: ComponentChildren }) {
  return <article data-testid="l-blog">{children}</article>;
}
