import type { ReactNode } from "react";

export const head = { title: "nested", meta: [{ name: "description", content: "nested layout" }] };

export default function Nested({ children }: { children?: ReactNode }) {
  return <section data-testid="rsc-nested">{children}</section>;
}
