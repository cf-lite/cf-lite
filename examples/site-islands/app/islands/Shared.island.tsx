import { useState } from "react";

// a second island on the same page: both share the react chunk, each has its own island chunk
export default function Shared({ by }: { by: number }) {
  const [n, setN] = useState(0);
  return <button data-testid="shared" onClick={() => setN(n + by)}>shared {n}</button>;
}
