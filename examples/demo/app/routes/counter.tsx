import { useState } from "react";
import { Link } from "@cf-lite/react/client";

export const head = { title: "Counter — cf-lite", meta: [{ name: "description", content: "SPA counter" }] };

export default function Counter() {
  const [n, setN] = useState(0);
  return (
    <main>
      <h1>SPA counter</h1>
      <button data-testid="inc" onClick={() => setN(n + 1)}>clicked {n}</button> <Link to="/">home</Link>
    </main>
  );
}
