/**
 * `server/cron/<name>.ts` -> the Worker's `scheduled()` handler (generated `.cf-lite/handlers.ts`).
 *
 *   export const schedule = "*\/15 * * * *";            // or an array of expressions
 *   export default async (ev: ScheduledController, env: Env, ctx: ExecutionContext) => { ... };
 *
 * The dispatcher picks files by `ev.cron` (exact match against the expression Cloudflare passes). Several files may share an
 * expression: they run concurrently and a failure in one does not stop the others (the invocation still fails afterwards).
 * `checks` diff the `triggers.crons` of the wrangler config against the files, in both directions.
 */
import { defineConvention } from "./types.js";
import { asArray, hasDefault, imp, readStrings, scanJobDir } from "./jobs-util.js";

export interface CronEntry { file: string; name: string; schedules: string[]; hasDefault: boolean }

export const cronConvention = defineConvention<CronEntry[]>({
  name: "cron",
  scan: ({ root }) => scanJobDir(root, "cron").map((f) => ({ file: f.file, name: f.name, schedules: readStrings(f.src, "schedule") ?? [], hasDefault: hasDefault(f.src) })),
  emit: (cron) => {
    if (!cron.length) return {};
    const active = cron.filter((c) => c.schedules.length && c.hasDefault);
    const all = [...new Set(cron.flatMap((c) => c.schedules))].sort();
    return {
      handlers: active.length
        ? {
            imports: [`import { dispatchCron } from "cf-lite/modules/cron";`, ...active.map((c, i) => `import c${i} from ${JSON.stringify(imp(c.file))};`)],
            scheduled: `(ev, env, ctx) => dispatchCron([${active.map((c, i) => `{ name: ${JSON.stringify(c.name)}, schedules: ${JSON.stringify(c.schedules)}, run: c${i} }`).join(", ")}], ev, env, ctx)`,
          }
        : undefined,
      checks: [
        () => cron.filter((c) => !c.schedules.length).map((c) => `${c.file} has no \`export const schedule = "<cron expression>"\``),
        () => cron.filter((c) => !c.hasDefault).map((c) => `${c.file} has no default export (\`export default async (ev, env, ctx) => { ... }\`)`),
        (w) => {
          const have = asArray((w.triggers as { crons?: unknown } | undefined)?.crons).map(String);
          const missing = all.filter((s) => !have.includes(s));
          const extra = have.filter((s) => !all.includes(s));
          return [
            ...(missing.length ? [`server/cron: wrangler \`triggers.crons\` lacks ${JSON.stringify(missing)} (add it, or run \`cf-lite add cron <name>\`) - those files never fire`] : []),
            ...(extra.length ? [`wrangler \`triggers.crons\` has ${JSON.stringify(extra)} but no server/cron file declares it - the generated scheduled() would do nothing for it`] : []),
          ];
        },
      ],
    };
  },
});
