/**
 * Runtime of the `server/cron/*.ts` convention (docs/background-jobs.md). Imported by the generated `.cf-lite/handlers.ts` only.
 */
export type CronHandler = (ev: ScheduledController, env: any, ctx: ExecutionContext) => void | Promise<void>;
export interface CronJob { name: string; schedules: string[]; run: CronHandler }

/**
 * Run every job whose schedule equals `ev.cron`, concurrently. A failing job is logged and does not stop the others; the
 * invocation then throws so Cloudflare records the cron run as failed. An expression no job declares is logged, not thrown.
 */
export async function dispatchCron(jobs: CronJob[], ev: ScheduledController, env: unknown, ctx: ExecutionContext): Promise<void> {
  const hit = jobs.filter((j) => j.schedules.includes(ev.cron));
  if (!hit.length) { console.warn(`[cf-lite] cron "${ev.cron}" matched no server/cron file`); return; }
  const results = await Promise.allSettled(hit.map((j) => Promise.resolve().then(() => j.run(ev, env, ctx))));
  const failed = results.flatMap((r, i) => (r.status === "rejected" ? [{ job: hit[i].name, error: r.reason }] : []));
  for (const f of failed) console.error(`[cf-lite] cron job "${f.job}" failed:`, f.error);
  if (failed.length) throw new Error(`cron "${ev.cron}": ${failed.length} job(s) failed: ${failed.map((f) => f.job).join(", ")}`);
}
