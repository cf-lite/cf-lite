import type { ComponentChildren } from "preact";

export default function AppShell({ children }: { children?: ComponentChildren }) {
  return <section data-testid="l-app"><aside>app shell</aside>{children}</section>;
}
