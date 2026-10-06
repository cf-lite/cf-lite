import type { ReactNode } from "react";

export default function AppShell({ children }: { children?: ReactNode }) {
  return <section data-testid="l-app"><aside>app shell</aside>{children}</section>;
}
