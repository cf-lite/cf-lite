import type { ReactNode } from "react";
import { Link } from "@cf-lite/react/client";

export default function Root({ children }: { children?: ReactNode }) {
  return <div data-testid="l-root"><nav><Link to="/">home</Link> <Link to="/pricing">pricing</Link></nav>{children}</div>;
}
