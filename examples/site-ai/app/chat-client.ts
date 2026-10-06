// Added by `cf-lite add ai-chat`. Minimal streaming chat UI: `import { mountChat } from "./chat-client"; mountChat(document.getElementById("chat")!);`
import { readChatStream, type ChatMessage } from "cf-lite/modules/ai";

export function mountChat(root: HTMLElement) {
  const history: ChatMessage[] = [];
  root.innerHTML = `<ol data-chat-log style="list-style:none;padding:0"></ol><form data-chat-form><input name="q" autocomplete="off" required maxlength="4000" /> <button>Send</button></form><output data-chat-status role="status"></output>`;
  const log = root.querySelector<HTMLOListElement>("[data-chat-log]")!;
  const form = root.querySelector<HTMLFormElement>("[data-chat-form]")!;
  const status = root.querySelector<HTMLOutputElement>("[data-chat-status]")!;
  const add = (role: string, text: string) => { const li = document.createElement("li"); li.dataset.role = role; li.textContent = text; log.appendChild(li); return li; };
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = form.elements.namedItem("q") as HTMLInputElement;
    const q = input.value.trim(); if (!q) return;
    input.value = ""; form.querySelector("button")!.disabled = true; status.textContent = "";
    history.push({ role: "user", content: q }); add("user", q);
    const li = add("assistant", "");
    try {
      const res = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: history }) });
      const full = await readChatStream(res, { onText: (_d, all) => (li.textContent = all) });
      history.push({ role: "assistant", content: full });
    } catch { status.textContent = "Something went wrong - try again."; li.remove(); history.pop(); }
    finally { form.querySelector("button")!.disabled = false; input.focus(); }
  });
}
