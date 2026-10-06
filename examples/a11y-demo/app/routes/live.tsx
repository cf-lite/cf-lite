import { useState } from "react";
import { useLang } from "../lang";

export const head = { title: "Live list - cf-lite accessibility demo" };

export default function Live() {
  const { t } = useLang();
  const [items, setItems] = useState<number[]>([]);
  const [msg, setMsg] = useState("");
  const add = () => { const n = items.length + 1; setItems([...items, n]); setMsg(`${t.item} ${n} ${t.added} ${n}`); };
  const clear = () => { setItems([]); setMsg(t.cleared); };
  return (
    <main id="main">
      <h1>{t.liveTitle}</h1>
      <p>{t.liveIntro}</p>
      <p><button type="button" onClick={add}>{t.add}</button> <button type="button" onClick={clear}>{t.clear}</button></p>
      <div role="status" aria-live="polite" aria-atomic="true">{msg}</div>
      {items.length === 0 ? <p>{t.empty}</p> : <ul>{items.map((n) => <li key={n}>{t.item} {n}</li>)}</ul>}
    </main>
  );
}
