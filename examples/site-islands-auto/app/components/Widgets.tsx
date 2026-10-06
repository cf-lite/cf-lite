import { useEffect, useState, type ReactNode } from "react";

export const client = "idle"; // module-level strategy still works for auto islands

// named export, interactive: island
export function Like({ id }: { id: string }) {
  const [liked, setLiked] = useState(false);
  return <button data-testid={`like-${id}`} onClick={() => setLiked(!liked)}>{liked ? "liked" : "like"} {id}</button>;
}

// no hooks, no handlers: stays plain server HTML (no island, no JS)
export function Badge({ text }: { text: string }) {
  return <b data-testid="badge">{text}</b>;
}

// takes children: cannot cross into the browser, reported at build, renders as plain HTML
export function Panel({ children }: { children?: ReactNode }) {
  const [open, setOpen] = useState(true);
  return <section data-testid="panel"><button onClick={() => setOpen(!open)}>toggle</button>{open && children}</section>;
}

// island that renders another island and passes it a function: the inner one falls back to a plain component inside the outer tree
function Row({ onPick, label }: { onPick: () => void; label: string }) {
  const [hover, setHover] = useState(false);
  return <li onMouseEnter={() => setHover(true)}><button data-testid={`row-${label}`} onClick={onPick}>{label}{hover ? "!" : ""}</button></li>;
}
export { Row };
export function Picker({ items }: { items: string[] }) {
  const [picked, setPicked] = useState("none");
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return <div data-testid="picker" data-mounted={mounted}><p data-testid="picked">picked: {picked}</p><ul>{items.map((i) => <Row key={i} label={i} onPick={() => setPicked(i)} />)}</ul></div>;
}
