import { purgePaths } from "cf-lite/modules/cache";
import { fail, saveUpload, type ActionMap } from "cf-lite/modules/actions";
import { redirect } from "cf-lite/navigation";
import { contactSchema, defineAction } from "../../server/schema";
import { messages } from "../../server/store";

export const render = "ssr";

export const loader = () => ({ count: messages.length });

export const actions = {
  // validated; invalid input re-renders this page with 422 + field errors, valid input re-renders with { ok: true }
  send: defineAction(contactSchema, (v, c) => {
    messages.push({ name: v.name, message: v.message });
    purgePaths(c.env as never, "/contact").catch(() => {}); // revalidate cached copies of this page (no-op without a tag store binding)
    return { ok: true, name: v.name };
  }),
  // returns nothing -> 303 back to /contact (Post/Redirect/Get)
  clear: () => { messages.length = 0; },
  // redirect sentinel -> 303 to /thanks
  go: () => redirect("/thanks"),
  // file -> R2 (`wrangler.jsonc` binding FILES); UploadError becomes a 413/415 re-render
  upload: async (form, c) => {
    const key = `uploads/${crypto.randomUUID()}`;
    const r = await saveUpload((c.env as { FILES: R2Bucket }).FILES, form.get("file"), key, { maxBytes: 64 * 1024, allowTypes: ["text/plain", "image/*"] });
    return { uploaded: r.key, size: r.size };
  },
  boom: () => { throw new Error("secret stack detail"); },
  teapot: () => fail(418, { error: "I am a teapot" }),
} satisfies ActionMap;

type Data = { count: number; actionData?: { ok?: boolean; name?: string; errors?: Record<string, string[]>; values?: Record<string, string>; uploaded?: string; size?: number; error?: string } };

export default function Contact({ data }: { data: Data }) {
  const a = data.actionData;
  return (
    <main>
      <h1>Contact</h1>
      <p data-testid="count">messages: {data.count}</p>
      {a?.ok && <p data-testid="ok">Thanks {a.name}</p>}
      {a?.uploaded && <p data-testid="uploaded">uploaded {a.size}</p>}
      {a?.error && <p data-testid="error">{a.error}</p>}
      <form method="post" action="?/send">
        <input name="name" defaultValue={a?.values?.name ?? ""} placeholder="name" />
        {a?.errors?.name && <span data-testid="err-name">{a.errors.name[0]}</span>}
        <input name="email" defaultValue={a?.values?.email ?? ""} placeholder="email" />
        {a?.errors?.email && <span data-testid="err-email">{a.errors.email[0]}</span>}
        <textarea name="message" defaultValue={a?.values?.message ?? ""} />
        {a?.errors?.message && <span data-testid="err-message">{a.errors.message[0]}</span>}
        <button type="submit">Send</button>
        <button type="submit" formAction="?/go">Go</button>
      </form>
      <form method="post" action="?/clear"><button type="submit">Clear</button></form>
      <form method="post" action="?/upload" encType="multipart/form-data"><input type="file" name="file" /><button type="submit">Upload</button></form>
    </main>
  );
}
