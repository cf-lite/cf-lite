export {};
const log = document.getElementById("log")!;
const form = document.getElementById("f") as HTMLFormElement;
const q = document.getElementById("q") as HTMLInputElement;
const chat: Array<{ role: string; content: string }> = [];

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  chat.push({ role: "user", content: q.value });
  log.appendChild(Object.assign(document.createElement("p"), { textContent: "You: " + q.value }));
  q.value = "";
  const out = Object.assign(document.createElement("p"), { textContent: "AI: " });
  log.appendChild(out);
  const res = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: chat }) });
  if (!res.ok || !res.body) { out.textContent += `error ${res.status}`; return; }
  let text = "", buf = "";
  const reader = res.body.getReader(), dec = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n"); buf = lines.pop()!;
    for (const l of lines) if (l.startsWith("data: ") && l !== "data: [DONE]") { try { text += JSON.parse(l.slice(6)).response ?? ""; } catch { /* partial frame */ } }
    out.textContent = "AI: " + text;
  }
  chat.push({ role: "assistant", content: text });
});
