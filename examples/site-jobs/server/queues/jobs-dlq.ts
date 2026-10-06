import { defineQueue } from "cf-lite/modules/queue";
import type { Message as JobMessage } from "./jobs";

export const queue = "jobs-dlq";
export const binding = "JOBS_DLQ_QUEUE";

export default defineQueue<JobMessage>({
  each: async (body, _msg, env) => { await env.STATE.put(`dlq:${body.id}`, "1"); },
});
