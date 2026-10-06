import { useState } from "react";

export const client = "load";
export default function Counter({ start = 0 }: { start?: number }) {
  const [n, setN] = useState(start);
  return <button type="button" data-testid="counter" className="btn" onClick={() => setN(n + 1)}>clicks: {n}</button>;
}
