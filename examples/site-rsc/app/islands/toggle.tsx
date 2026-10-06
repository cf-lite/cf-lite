"use client";
import { useState } from "react";

export function Toggle() {
  const [on, setOn] = useState(false);
  return <button id="toggle" onClick={() => setOn(!on)}>{on ? "on" : "off"}</button>;
}
