import { purgeTags } from "cf-lite/modules/cache";

export const render = "ssr";
/** Cached at the edge for a minute, tagged `board`; posting a note purges the tag so the next GET re-renders. */
export const cache = { maxAge: 60, tags: ["board"] };

const notes: string[] = [];
export const loader = () => ({ notes: [...notes] });

export const actions = {
  add: async (form: FormData, c: { env: unknown }) => {
    notes.push(String(form.get("note") ?? "").slice(0, 100));
    await purgeTags(c.env as never, "board");
  },
};

export default function Board({ data }: { data: { notes: string[] } }) {
  return (
    <main>
      <h1>Board</h1>
      <ul data-testid="notes">{data.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
      <form method="post" action="?/add"><input name="note" /><button type="submit">Add</button></form>
    </main>
  );
}
