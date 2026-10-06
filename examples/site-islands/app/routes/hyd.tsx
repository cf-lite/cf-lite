import Counter from "../islands/Counter.island";

// hydrate = true: the page hydrates as a whole, so the island runtime is NOT added (no double hydration).
export const render = "ssr";
export const hydrate = true;

export default function Hyd() {
  return <main><h1>Hydrated page</h1><Counter start={1} /></main>;
}
