import { useState } from "react";

export const render = "ssr";
export const hydrate = true;
export const loader = () => ({ at: "request" });

export default function Ssr({ data }: { data: { at: string } }) {
  const [n, setN] = useState(0);
  return <main><h1>SSR</h1><p data-testid="at" style={{ fontWeight: 600 }}>{data.at}</p><button data-testid="inc" onClick={() => setN(n + 1)}>count {n}</button></main>;
}
