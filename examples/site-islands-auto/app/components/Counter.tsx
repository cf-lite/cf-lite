import { useState } from "react";

// A plain component: nothing marks it as an island. The build sees useState + onClick and wraps it.
export default function Counter({ start = 0, label = "clicks" }: { start?: number; label?: string }) {
  const [n, setN] = useState(start);
  return <button data-testid="counter" onClick={() => setN(n + 1)}>{label}: {n}</button>;
}
