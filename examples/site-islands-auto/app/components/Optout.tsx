import { useState } from "react";

export const island = false; // opt out: stays an ordinary component (dead handlers unless the page hydrates)
export default function Optout() {
  const [n, setN] = useState(0);
  return <button data-testid="optout" onClick={() => setN(n + 1)}>optout {n}</button>;
}
