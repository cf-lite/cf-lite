import type { JSX } from "solid-js";

export default function AppShell(props: { children?: JSX.Element }) {
  return <section data-testid="l-app"><aside>app shell</aside>{props.children}</section>;
}
