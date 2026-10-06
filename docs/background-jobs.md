# Background work: cron, Queues, Workflows, email, `after()`

Everything is a **file convention** compiled at build time into `.cf-lite/handlers.ts` (see `docs/conventions.md`); no runtime is added unless you use it.
With none of `server/{cron,queues,workflows,email}` present, no generated file exists and nothing is bundled.

```
server/cron/<name>.ts        ->  scheduled()    by ev.cron
server/queues/<name>.ts      ->  queue()        by batch.queue   + typed producer  queues.<name>.send()
server/workflows/<name>.ts   ->  class re-exports                + typed producer  workflows.<name>.create()
server/email/<name>.ts       ->  email()        by recipient
```

Wire it once in `server/worker.ts` (every part is optional; `examples/site-jobs` uses all of them):

```ts
import app from "../.cf-lite/app";
import { handlers } from "../.cf-lite/handlers";          // { scheduled, queue, email } - only the ones you have
export * from "../.cf-lite/workflow-classes";              // only with server/workflows
export default { fetch: app.fetch, ...handlers } satisfies ExportedHandler<Env>;
```

`cf-lite add cron|queue|workflow|email <name>` scaffolds the file and edits `wrangler.jsonc` (text-level, comments kept, idempotent; prints the snippet when the file is too unusual to patch).
At dev/build start, checks diff your wrangler config against the files and print `[cf-lite] ...` warnings (missing/extra crons, producer/consumer/workflow bindings, `class_name` mismatches).

## Cron

```ts
// server/cron/cleanup.ts
export const schedule = "0 3 * * *";            // or ["0 3 * * *", "0 15 * * *"]
export default async (ev: ScheduledController, env: Env, ctx: ExecutionContext) => { ... };
```

The dispatcher runs every file whose schedule equals `ev.cron`. Files sharing an expression run concurrently; one failing does not stop the others, but the invocation
then fails (so it shows up as a failed run). Add the same expression to `triggers.crons` in wrangler (the checks tell you when they drift). Test locally with
`wrangler dev --test-scheduled` and `curl "localhost:8787/cdn-cgi/handler/scheduled?cron=0+3+*+*+*"`. Static read: `schedule` must be a string/array literal.

## Queues

```ts
// server/queues/emails.ts
import { defineQueue, backoff } from "cf-lite/modules/queue";
export type Message = { to: string };               // types queues.emails.send()  (or `export const schema = z.object(...)`: validated on send + typed)
export default defineQueue<Message>({
  each: async (body, msg, env) => { await sendMail(body.to); },   // throw -> only this message is retried
  retryDelay: backoff({ base: 30, factor: 2, max: 3600 }),       // seconds, from msg.attempts
  // maxAttempts: 5, onDead: async (body, msg, err) => {...}     // in-code dead handling (acks after onDead)
});
// or a raw handler: export default async (batch, env, ctx) => { ... }
```

- Queue name = file name (override: `export const queue = "x"`); producer binding = `<FILE_NAME>_QUEUE` (override: `export const binding = "X"`).
- Producer: `await queues.emails.send({ to })`, `sendBatch([...])` (chunked at 100 per call) from `../.cf-lite/queues`. The message type is compile-checked
  (`examples/site-jobs` has a `@ts-expect-error` compile test that `bun run typecheck` enforces).
- **Retries / DLQ**: Cloudflare owns them: set `max_retries`, `retry_delay` and `dead_letter_queue` on the consumer in wrangler. The DLQ consumer is just another file
  (`emails-dlq.ts` with `export const queue = "emails-dlq"`). `defineQueue` adds per-message ack/retry so one bad message doesn't redeliver the batch.
- Two files handling one queue name is a build error; a batch for an unknown queue throws (Cloudflare retries/dead-letters it).
- `@cf-lite/testing`: `fakeQueue()` replaces the producer in unit tests; `queues.<name>` reads the binding through `cloudflare:workers` `env`, so it works against the test env too.

**Plan**: Queues works on the Workers **Free** plan (10,000 operations/day, 24 h message retention; Paid raises both). Verified 2026-09-30 from developers.cloudflare.com/queues/platform/pricing. Local dev (`wrangler dev`, miniflare) needs nothing. Re-check the limits before relying on them: they are Cloudflare's to change.

## Workflows

```ts
// server/workflows/onboarding.ts
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
export default class Onboarding extends WorkflowEntrypoint<Env, { userId: string }> {
  async run(event: WorkflowEvent<{ userId: string }>, step: WorkflowStep) { await step.do("welcome", async () => { ... }); }
}
```

Class name = PascalCase of the file name (override: `export const className`), binding `<FILE_NAME>_WORKFLOW` (`export const binding`); both must match the wrangler `workflows` entry.
`await workflows.onboarding.create({ id, params })` / `.get(id)` / `.status(id)` from `../.cf-lite/workflows`; `params` is typed from the class's `WorkflowEntrypoint<Env, Params>`.
Recipes (ISR regeneration, onboarding, report export) build on this; ISR is WP-ISR.

## Email (`email()`, stretch)

`server/email/<name>.ts`: `export const match = "support@x.com" | ["a@x.com", "*@x.com", "sales@*"]` (omit = catch-all) and a default `(message, env, ctx)` handler. The first specific
match wins (file-name order), then the first catch-all; no match rejects the message (`setReject`). Local test: `POST /cdn-cgi/handler/email?from=..&to=..` with a raw MIME body.
*Needs the owner*: an Email Routing rule pointing at the Worker needs a real domain on Cloudflare (dashboard/API); not automated here.

## `after()`

```ts
import { after } from "cf-lite/modules/after";
app.post("/order", async (c) => { const o = await save(c); after(() => sendReceipt(o)); return c.json(o); });
```

`after(fn | promise)` = `waitUntil` for the **current request** (taken from `cloudflare:workers`, no context threading), with error capture (`console.error`, or
`setAfterErrorHandler(fn)` to forward to your reporter). Also `after(task, c.executionCtx)` if you prefer the explicit form.
Limits: no request exists inside queue/cron/workflow handlers (just `await`); the task is **not retried** (use a queue for anything that must not be lost); after the response is sent
the Worker gets a bounded wall-time budget for `waitUntil` work *(verify: documented as 30 s)* and work running past it is cancelled.

## Tests

Unit: `packages/cf-lite/test/jobs.test.ts` (conventions, dispatchers, retry/backoff, producers, `add`, zero-bytes-when-unused). Runtime under workerd: `scripts/jobs-e2e.mjs`
(`bun run test:e2e`) drives `examples/site-jobs` through `wrangler dev`: enqueue -> consumer -> retry (attempt 2) -> DLQ consumer, cron dispatch by expression (+ unknown expression),
workflow steps, `after()` not blocking the response, email routing/rejection.
