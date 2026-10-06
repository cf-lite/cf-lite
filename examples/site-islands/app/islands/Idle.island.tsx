import { useState } from "react";

export const client = "idle";
export default function Idle() {
  const [on, setOn] = useState(false);
  return <button data-testid="idle" onClick={() => setOn(!on)}>idle {on ? "on" : "off"}</button>;
}
