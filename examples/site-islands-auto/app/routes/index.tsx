import Counter from "../components/Counter";
import Optout from "../components/Optout";
import { Badge, Like, Panel, Picker } from "../components/Widgets";

export const render = "static";
export const head = { title: "Auto islands" };

export default function Home() {
  return (
    <main>
      <h1>Auto islands</h1>
      <Counter start={2} />
      <Like id="a" /><Like id="b" />
      <Badge text="static" />
      <Panel><p data-testid="panel-body">inside</p></Panel>
      <Picker items={["x", "y"]} />
      <Optout />
    </main>
  );
}
