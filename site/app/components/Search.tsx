import { useEffect, useMemo, useState } from "preact/hooks";

interface Entry { u: string; p: string; h: string; t: string }
const tokens = (s: string) => s.toLowerCase().match(/[a-z0-9_.+-]{2,}/g) ?? [];
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

function score(e: Entry, q: string[]): number {
  const h = e.h.toLowerCase(), t = e.t.toLowerCase(), p = e.p.toLowerCase();
  let s = 0;
  for (const w of q) {
    const inH = h.includes(w), inT = t.includes(w), inP = p.includes(w);
    if (!inH && !inT && !inP) return 0; // AND semantics
    s += (inH ? 6 : 0) + (inP ? 2 : 0) + (inT ? 1 + Math.min(3, t.split(w).length - 2) * 0.3 : 0);
  }
  return s;
}
function snippet(t: string, q: string[]): string {
  const low = t.toLowerCase(); const at = Math.max(0, Math.min(...q.map((w) => { const i = low.indexOf(w); return i < 0 ? 1e9 : i; })));
  let out = esc(t.slice(Math.max(0, at - 40), at + 150));
  for (const w of q) out = out.replace(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), (m) => `<mark>${m}</mark>`);
  return (at > 40 ? "… " : "") + out + "…";
}

export function Search() {
  const [idx, setIdx] = useState<Entry[] | null>(null);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const init = new URLSearchParams(location.search).get("q");
    if (init) setQ(init);
    fetch("/search-index.json").then((r) => r.json() as Promise<Entry[]>).then(setIdx, () => setErr("Could not load the search index."));
  }, []);
  const words = useMemo(() => tokens(q), [q]);
  const hits = useMemo(() => (idx && words.length ? idx.map((e) => ({ e, s: score(e, words) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 20) : []), [idx, words]);
  return (
    <div>
      <div class="sbox" role="search">
        <input type="search" value={q} placeholder="Search the docs…" aria-label="Search the docs" autofocus
          onInput={(ev) => { const v = (ev.target as HTMLInputElement).value; setQ(v); history.replaceState(null, "", v ? `?q=${encodeURIComponent(v)}` : location.pathname); }} />
      </div>
      <p aria-live="polite" class="lede" style="font-size:.95rem">
        {err || (!idx ? "Loading index…" : words.length ? `${hits.length} result${hits.length === 1 ? "" : "s"}` : `${idx.length} sections indexed.`)}
      </p>
      <ol class="hits">
        {hits.map(({ e }) => (
          <li><a href={e.u}>{e.h}</a><small>{e.p}</small><p dangerouslySetInnerHTML={{ __html: snippet(e.t, words) }} /></li>
        ))}
      </ol>
    </div>
  );
}
