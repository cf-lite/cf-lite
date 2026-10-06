import { useState } from "react";

export const client = "visible";
export default function Lazy({ id }: { id: string }) {
  const [n, setN] = useState(0);
  return <button data-testid={"visible-" + id} onClick={() => setN(n + 1)}>visible {id}: {n}</button>;
}
