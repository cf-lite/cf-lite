import type { ReactNode } from "react";
export const head = { meta: [{ name: "description", content: "bench" }] };
export default function Root({ children }: { children?: ReactNode }) { return <div><header>bench</header>{children}</div>; }
