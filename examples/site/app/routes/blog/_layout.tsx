import type { ReactNode } from "react";

export default function BlogLayout({ children }: { children?: ReactNode }) {
  return <article data-testid="l-blog">{children}</article>;
}
