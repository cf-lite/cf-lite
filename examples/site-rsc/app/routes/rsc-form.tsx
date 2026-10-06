// P3: form-based server action + actionGuard (rate-limit hook) + body limit; the counter island keeps its state across an in-place action refresh.
import { guestbook } from "../lib/guestbook-store";
import { sign } from "../actions/guestbook";
import { Counter } from "../islands/counter";

export const render = "rsc";
export const head = { title: "form" };
export const serverActions = [sign]; // per-route allowlist: only these ids are accepted on POST /rsc-form
export const actionMaxBytes = 4096;
export const actionGuard = ({ req }: { req: Request }) => req.headers.get("x-e2e-rate") === "deny" ? false : true; // real apps: a memoryLimiter/binding keyed by IP

export default function Page() {
  return <main>
    <h1 id="mode">form</h1>
    <ul id="names">{guestbook.names.map((n, i) => <li key={i}>{n}</li>)}</ul>
    <p id="last">{guestbook.lastUrl}</p>
    <form action={sign} id="f"><input name="name" id="name" /><button id="sign">sign</button></form>
    <Counter label="clicks" />
  </main>;
}
