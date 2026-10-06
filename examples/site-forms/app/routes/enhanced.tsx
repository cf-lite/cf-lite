import { Form, useFormStatus } from "@cf-lite/react/form";
import { defineAction, type ActionMap } from "cf-lite/modules/actions";
import { redirect } from "cf-lite/navigation";
import { contactSchema } from "../../server/schema";
import { messages } from "../../server/store";

export const render = "ssr";
export const hydrate = true;
export const loader = () => ({ count: messages.length });

export const actions = {
  send: defineAction(contactSchema, async (v) => {
    await new Promise((r) => setTimeout(r, 300)); // slow enough for the pending state to be observable
    messages.push({ name: v.name, message: v.message });
    return { ok: true, name: v.name };
  }),
  go: () => redirect("/thanks"),
} satisfies ActionMap;

function Submit() { const { pending } = useFormStatus(); return <button type="submit" data-testid="submit">{pending ? "Sending…" : "Send"}</button>; }
function Result() {
  const { result } = useFormStatus<{ ok?: boolean; name?: string; errors?: Record<string, string[]> }>();
  if (result?.type === "failure") return <p data-testid="js-errors">{Object.values(result.data.errors ?? {}).flat().join(" | ")}</p>;
  if (result?.type === "success") return <p data-testid="js-ok">Thanks {result.data.name}</p>;
  return null;
}

export default function Enhanced({ data }: { data: { count: number; actionData?: { ok?: boolean; name?: string; errors?: Record<string, string[]> } } }) {
  const a = data.actionData;
  return (
    <main>
      <h1>Enhanced</h1>
      <p data-testid="count">messages: {data.count}</p>
      {a?.ok && <p data-testid="ok">Thanks {a.name}</p>}
      <Form action="?/send">
        <input name="name" placeholder="name" /><input name="email" placeholder="email" /><input name="message" placeholder="message" />
        <Submit /><button type="submit" formAction="?/go" data-testid="go">Go</button>
        <Result />
      </Form>
    </main>
  );
}
