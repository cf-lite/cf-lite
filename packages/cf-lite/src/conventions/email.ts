/**
 * `server/email/<name>.ts` -> the Worker's `email()` handler (inbound Email Routing), dispatched by recipient.
 *
 *   export const match = "support@example.com";          // or ["a@x.com", "*@x.com", "sales@*"]; omit = catch-all (runs only if nothing specific matched)
 *   export default async (message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext) => { ... };
 *
 * The first specific match wins (file-name order), then the first catch-all; no match rejects the message. Needs an Email Routing
 * rule pointing at the Worker (dashboard/API; a real domain - not something cf-lite can set up).
 */
import { defineConvention } from "./types.js";
import { hasDefault, imp, readStrings, scanJobDir } from "./jobs-util.js";

export interface EmailEntry { file: string; name: string; match?: string[]; hasDefault: boolean }

export const emailConvention = defineConvention<EmailEntry[]>({
  name: "email",
  scan: ({ root }) => scanJobDir(root, "email").map((f) => ({ file: f.file, name: f.name, match: readStrings(f.src, "match"), hasDefault: hasDefault(f.src) })),
  emit: (es) => {
    const active = es.filter((e) => e.hasDefault);
    if (!active.length) return {};
    return {
      handlers: {
        imports: [`import { dispatchEmail } from "cf-lite/modules/email";`, ...active.map((e, i) => `import e${i} from ${JSON.stringify(imp(e.file))};`)],
        email: `(message, env, ctx) => dispatchEmail([${active.map((e, i) => `{ name: ${JSON.stringify(e.name)}, ${e.match ? `match: ${JSON.stringify(e.match)}, ` : ""}run: e${i} }`).join(", ")}], message, env, ctx)`,
      },
      checks: [() => es.filter((e) => !e.hasDefault).map((e) => `${e.file} has no default export (\`export default async (message, env, ctx) => { ... }\`)`)],
    };
  },
});
