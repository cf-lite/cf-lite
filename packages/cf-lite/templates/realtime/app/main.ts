import { connectChannel } from "cf-lite/client-realtime";

const $ = (id: string) => document.getElementById(id)!;
const name = "guest-" + Math.random().toString(36).slice(2, 6);
const ch = connectChannel("/api/rooms/lobby", { params: { name } });

const who = new Map<string, string>();
const paint = () => { $("who").innerHTML = [...who.values()].map((n) => `<li>${n}</li>`).join(""); };
const line = (t: string) => { const li = document.createElement("li"); li.textContent = t; $("log").appendChild(li); };

ch.onStatus((s) => { $("status").textContent = s; });
ch.on<{ presence: { id: string; meta: { name: string } }[] }>("$hello", (h) => { who.clear(); for (const p of h.presence) who.set(p.id, p.meta.name); paint(); });
ch.on<{ op: string; id: string; meta: { name: string } }>("$presence", (p) => { if (p.op === "leave") who.delete(p.id); else who.set(p.id, p.meta.name); paint(); });
ch.on<{ name: string; text: string }>("chat", (m) => line(`${m.name}: ${m.text}`));

$("f").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("text") as HTMLInputElement;
  if (input.value) ch.send("chat", { text: input.value });
  input.value = "";
});
