import { useState } from "react";

// default strategy: "load" - hydrate as soon as the island runtime has loaded
export default function Counter({ start = 0, label = "count" }: { start?: number; label?: string }) {
  const [n, setN] = useState(start);
  return <button data-testid="counter" onClick={() => setN(n + 1)}>{label}: {n}</button>;
}
