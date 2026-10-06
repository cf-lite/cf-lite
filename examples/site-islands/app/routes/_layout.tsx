import type { ReactNode } from "react";

export default function Root({ children }: { children?: ReactNode }) {
  return <div data-testid="l-root">{children}</div>;
}
