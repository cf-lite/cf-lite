import type { ReactNode } from "react";

// Nested layout: only pages under app/routes/posts/ — wrapped *inside* the root layout.
export default function PostsLayout({ children }: { children?: ReactNode }) {
  return <section data-testid="layout-posts"><small>posts section</small>{children}</section>;
}
