import type { ReactNode } from "react";
import { Link } from "@cf-lite/react/client";

export default function Root({ children }: { children?: ReactNode }) {
  return <div><nav><Link to="/">home</Link> <Link to="/contact">contact</Link> <Link to="/enhanced">enhanced</Link></nav>{children}</div>;
}
