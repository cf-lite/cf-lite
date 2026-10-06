import type { ReactNode } from "react";

export default function Root({ children }: { children?: ReactNode }) {
  return <div><nav><a href="/">home</a> <a href="/about">about</a> <a href="/ssr">ssr</a></nav>{children}</div>;
}
