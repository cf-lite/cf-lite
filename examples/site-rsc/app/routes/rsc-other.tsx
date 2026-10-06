// P3: a second island, to show per-route client chunks (this route loads `toggle`, /rsc loads `counter`, /rsc-data neither).
import { Toggle } from "../islands/toggle";

export const render = "rsc";
export const head = { title: "other" };

export default function Page() {
  return <main><h1 id="mode">other</h1><Toggle /></main>;
}
