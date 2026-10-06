import { defineQueue } from "cf-lite/modules/queue";

export type Message = { id: string; fail?: boolean };

// Consumer config (max_retries 1, dead_letter_queue "jobs-dlq") lives in wrangler.jsonc; a failing message is retried once, then dead-lettered.
export default defineQueue<Message>({
  each: async (body, msg, env) => {
    await env.STATE.put(`attempt:${body.id}`, String(msg.attempts));
    if (body.fail) throw new Error(`job ${body.id} failed`);
    await env.STATE.put(`done:${body.id}`, "1");
  },
  retryDelay: 1,
});
