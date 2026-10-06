export const schedule = "*/5 * * * *";

export default async (ev: ScheduledController, env: Env) => {
  await env.STATE.put("cron:tick", String(ev.scheduledTime));
};
