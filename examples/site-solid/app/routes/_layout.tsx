import type { JSX } from "solid-js";
import { Link } from "@cf-lite/solid/client";

export const head = { meta: [{ name: "description", content: "site default" }] };

export default function Root(props: { children?: JSX.Element }) {
  return (
    <div data-testid="l-root">
      <nav>
        <Link to="/">home</Link> · <Link to="/about">about</Link> · <Link to="/app/dashboard">dashboard</Link> · <Link to="/app/settings">settings</Link> · <Link to="/blog/hello">blog</Link>
      </nav>
      {props.children}
    </div>
  );
}
