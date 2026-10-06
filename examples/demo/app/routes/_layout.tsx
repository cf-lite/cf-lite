import type { ReactNode } from "react";

// Root layout: wraps every page (spa, static and ssr alike). Nested layouts live in subfolders.
export const head = { meta: [{ name: "description", content: "cf-lite demo" }] };

export default function RootLayout({ children }: { children?: ReactNode }) {
  return (
    <div>
      <header data-testid="layout-root"><strong>cf-lite</strong> demo</header>
      {children}
    </div>
  );
}
