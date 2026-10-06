import Button from "@patterns/atoms/Button/Button";
import "../styles.css";

export const render = "static";
export const head = { title: "Patterns" };

export default function Home() {
  return <main><h1>Patterns</h1><p>Dev server: open <a href="/__preview">/__preview</a>. <code>MOCK=1</code> serves <code>mocks/</code>. <code>cfl export</code> writes HTML fragments.</p><Button label="Save" /></main>;
}
