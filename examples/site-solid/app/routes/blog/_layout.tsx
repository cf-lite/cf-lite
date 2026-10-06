import type { JSX } from "solid-js";

export default function BlogLayout(props: { children?: JSX.Element }) {
  return <article data-testid="l-blog">{props.children}</article>;
}
