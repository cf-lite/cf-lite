import Counter from "../islands/Counter.island";
import Idle from "../islands/Idle.island";
import Lazy from "../islands/Lazy.island";
import Menu from "../islands/Menu.island";
import Echo from "../islands/Echo.island";
import Shared from "../islands/Shared.island";

// Static page, no whole-page hydration: the only JS is the island runtime, and only because islands are on the page.
export const render = "static";
export const head = { title: "Islands" };

export default function Home() {
  return (
    <main>
      <h1>Islands</h1>
      <Counter start={2} label="clicks" />
      <Idle />
      <Menu />
      <Echo msg={'</script><img src=x onerror="window.__xss=1">&"<'} items={["a", "b"]} />
      <Shared by={1} /><Shared by={10} />
      <div style={{ height: 3000 }} data-testid="spacer">scroll</div>
      <Lazy id="low" />
    </main>
  );
}
