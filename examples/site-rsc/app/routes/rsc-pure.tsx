// P3: `hydrate = false` = pure server page: no script, no inline Flight payload (zero client JS).
export const render = "rsc";
export const hydrate = false;
export const head = { title: "pure" };

export default function Page() {
  return <main><h1 id="mode">pure server page</h1></main>;
}
