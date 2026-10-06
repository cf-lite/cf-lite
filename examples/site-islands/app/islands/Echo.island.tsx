import { useEffect, useState } from "react";

export default function Echo({ msg, items }: { msg: string; items: string[] }) {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  return <p data-testid="echo" data-ready={ready}>{msg} | {items.join(",")}</p>;
}
