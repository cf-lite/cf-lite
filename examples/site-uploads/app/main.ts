const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
async function refresh() {
  const rows: { key: string; size: number }[] = await (await fetch("/api/files")).json();
  $("list").replaceChildren(...rows.map((r) => Object.assign(document.createElement("li"), { textContent: `${r.key} (${r.size} B)` })));
}
$<HTMLInputElement>("f").addEventListener("change", async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const res = await fetch(`/api/files/${encodeURIComponent(file.name)}`, { method: "PUT", body: file, headers: { "content-type": file.type } });
  $("msg").textContent = res.ok ? "uploaded" : `failed: ${res.status} ${await res.text()}`;
  await refresh();
});
refresh();
