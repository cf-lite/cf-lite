"use client";
import { useState } from "react";

export function Counter({ label }: { label: string }) {
  const [n, setN] = useState(0);
  return <button id="counter" onClick={() => setN(n + 1)}>{label}: {n}</button>;
}
