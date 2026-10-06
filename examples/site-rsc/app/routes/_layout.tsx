import type { ReactNode } from "react";
import { Link } from "@cf-lite/react/client";

export const head = { meta: [{ name: "description", content: "site default" }] };

export default function Root({ children }: { children?: ReactNode }) {
  return (
    <div data-testid="l-root">
      <nav>
        <Link to="/">home</Link> · <Link to="/about">about</Link> · <Link to="/rsc">rsc</Link> · <Link to="/ssr">ssr</Link>
      </nav>
      {children}
    </div>
  );
}
