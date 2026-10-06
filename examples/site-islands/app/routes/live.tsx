import { lazy, Suspense, type ReactElement } from "react";
import Counter from "../islands/Counter.island";
import Echo from "../islands/Echo.island";

// SSR page (streamed): island props come from the loader, and an island sits inside a Suspense boundary that resolves late.
export const render = "ssr";
export const loader = async (c: { req: { query(k: string): string | undefined } }) => ({ name: c.req.query("name") ?? "world", start: 5 });

// lazy() runs its factory at render time (inside the request), so the timer is legal in workerd
const Late = lazy(() => new Promise<{ default: () => ReactElement }>((r) => setTimeout(() => r({ default: () => <Counter start={7} label="late" /> }), 50)));

export default function Live({ data }: { data: { name: string; start: number } }) {
  return (
    <main>
      <h1>Live {data.name}</h1>
      <Counter start={data.start} />
      <Echo msg={data.name} items={[]} />
      <Suspense fallback={<p>loading</p>}><Late /></Suspense>
    </main>
  );
}
