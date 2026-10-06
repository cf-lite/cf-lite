/**
 * Runtime helpers for cf-lite tests. Import inside test files (they run in workerd via vitest-pool-workers).
 *
 *   import { testApp, loginAs, fakeQueue, runScheduled } from "@cf-lite/testing";
 */
import { env, applyD1Migrations, createExecutionContext, createScheduledController, waitOnExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { exports } from "cloudflare:workers";

type Env = Record<string, any>;
type Handler = { fetch?: (req: Request, env: any, ctx: ExecutionContext) => Response | Promise<Response>; scheduled?: (c: ScheduledController, env: any, ctx: ExecutionContext) => void | Promise<void>; queue?: (b: MessageBatch<any>, env: any, ctx: ExecutionContext) => void | Promise<void> };

// ---- D1 migrations ---------------------------------------------------------------------------------------------------

/** Apply the migrations passed to `cfLiteTest({ migrations })` to every D1 binding (or just `db`). Idempotent. */
export async function applyMigrations(db?: D1Database): Promise<void> {
  const migrations = ((env as Env).TEST_MIGRATIONS ?? []) as { name: string; queries: string[] }[];
  if (!migrations.length) return;
  const targets = db ? [db] : Object.values(env as Env).filter(isD1);
  for (const d of targets) await applyD1Migrations(d, migrations);
}
const isD1 = (v: unknown): v is D1Database => !!v && typeof v === "object" && (v as object).constructor?.name === "D1Database"; // not duck-typed: Fetcher/DO stubs answer to any property

// ---- testApp ---------------------------------------------------------------------------------------------------------

export interface TestAppOptions {
  /** Your worker's default export. Omit to go through the real `main` of the wrangler config (full runtime, real bindings). */
  worker?: Handler;
  /** Binding overrides - only honoured with `worker` (e.g. `{ JOBS: fakeQueue() }`). */
  env?: Env;
  /** Base origin, default "https://example.com". */
  origin?: string;
}
export interface TestApp {
  /** Fetch a path (or absolute URL) against the app. Cookies set by earlier responses are replayed (per-`app`). */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** Same jar/env, but with extra default headers (e.g. a bearer token). */
  with(headers: Record<string, string>): TestApp;
  /** Cookie jar (name -> value). Mutate to simulate login/logout. */
  cookies: Map<string, string>;
  /** Bindings the app sees (real ones merged with overrides). */
  env: Env;
  /** `await` this after a request that used `ctx.waitUntil` to let background work finish. */
  settle(): Promise<void>;
}

export function testApp(opts: TestAppOptions = {}): TestApp {
  return build(opts, new Map(), {});
}
function build(opts: TestAppOptions, cookies: Map<string, string>, headers: Record<string, string>): TestApp {
  const origin = opts.origin ?? "https://example.com";
  const appEnv = { ...(env as Env), ...opts.env };
  let ctxs: ExecutionContext[] = [];
  const self: TestApp = {
    cookies, env: appEnv,
    with: (h) => build(opts, cookies, { ...headers, ...h }),
    async settle() { const c = ctxs; ctxs = []; await Promise.all(c.map((x) => waitOnExecutionContext(x))); },
    async fetch(path, init = {}) {
      const h = new Headers(init.headers);
      for (const [k, v] of Object.entries(headers)) if (!h.has(k)) h.set(k, v);
      if (cookies.size && !h.has("cookie")) h.set("cookie", [...cookies].map(([k, v]) => `${k}=${v}`).join("; "));
      const req = new Request(new URL(path, origin), { redirect: "manual", ...init, headers: h });
      let res: Response;
      if (opts.worker) {
        const ctx = createExecutionContext(); ctxs.push(ctx);
        res = await opts.worker.fetch!(req, appEnv, ctx);
      } else res = await (exports as any).default.fetch(req);
      for (const sc of res.headers.getSetCookie()) {
        const [pair, ...attrs] = sc.split(";"); const i = pair.indexOf("=");
        const name = pair.slice(0, i).trim(), value = pair.slice(i + 1).trim();
        const dead = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === "";
        if (dead) cookies.delete(name); else cookies.set(name, value);
      }
      return res;
    },
  };
  return self;
}

// ---- loginAs ---------------------------------------------------------------------------------------------------------

export interface LoginOptions {
  /** Route mounted with `e2eLogin()` (cf-lite/modules/e2e-login). Default "/__e2e/login". */
  path?: string;
  /** The app's `E2E_LOGIN_SECRET`. Default: read from the test env. */
  secret?: string;
  /** Header name, matches `e2eLogin({ header })`. Default "x-e2e-secret". */
  header?: string;
}
/** Sign `app` in as `user` through the e2e-login route; the session cookie lands in `app.cookies`. Returns the login response. */
export async function loginAs(app: TestApp, user: string, opts: LoginOptions = {}): Promise<Response> {
  const secret = opts.secret ?? (app.env.E2E_LOGIN_SECRET as string | undefined);
  if (!secret) throw new Error("loginAs: no secret - pass { secret } or bind E2E_LOGIN_SECRET via cfLiteTest({ bindings })");
  const res = await app.fetch(opts.path ?? "/__e2e/login", {
    method: "POST", headers: { [opts.header ?? "x-e2e-secret"]: secret, "content-type": "application/json" }, body: JSON.stringify({ user }),
  });
  if (res.status >= 400) throw new Error(`loginAs(${user}) failed: ${res.status}`);
  return res;
}

// ---- cron ------------------------------------------------------------------------------------------------------------

/** Trigger a worker's `scheduled()` like the cron would, await its `waitUntil`s. `time` may be a Date/number to freeze `scheduledTime`. */
export async function runScheduled(worker: Handler, opts: { cron?: string; time?: Date | number; env?: Env } = {}): Promise<void> {
  if (!worker.scheduled) throw new Error("runScheduled: worker has no scheduled() handler");
  const ctrl = createScheduledController({ cron: opts.cron ?? "* * * * *", scheduledTime: opts.time === undefined ? Date.now() : +opts.time });
  const ctx = createExecutionContext();
  await worker.scheduled(ctrl, { ...(env as Env), ...opts.env }, ctx);
  await waitOnExecutionContext(ctx);
}

// ---- fake Queue producer ---------------------------------------------------------------------------------------------

export interface SentMessage<T = unknown> { body: T; contentType: string; delaySeconds?: number }
export interface FakeQueue<T = unknown> {
  send(body: T, opts?: { contentType?: string; delaySeconds?: number }): Promise<void>;
  sendBatch(msgs: Iterable<{ body: T; contentType?: string; delaySeconds?: number }>, opts?: { delaySeconds?: number }): Promise<void>;
  /** Everything produced so far. */
  readonly messages: SentMessage<T>[];
  readonly bodies: T[];
  /** Throws unless a message matching `match` (deep-equal on the given subset for objects, `===` otherwise) was sent. */
  expectSent(match?: Partial<T> | T): SentMessage<T>;
  expectNoneSent(): void;
  clear(): void;
  /** Deliver the recorded messages to a consumer (`queue()` handler) and report ack/retry per message id. */
  deliver(consumer: Handler, opts?: { queueName?: string; env?: Env }): Promise<{ explicitAcks: string[]; retryMessages: { msg: string; delaySeconds?: number }[]; retryBatch: { retry: boolean } }>;
}
export function fakeQueue<T = unknown>(name = "test-queue"): FakeQueue<T> {
  const messages: SentMessage<T>[] = [];
  const subset = (actual: any, want: any): boolean =>
    want && typeof want === "object" ? actual && typeof actual === "object" && Object.entries(want).every(([k, v]) => subset(actual[k], v)) : actual === want;
  return {
    messages,
    get bodies() { return messages.map((m) => m.body); },
    async send(body, o) { messages.push({ body, contentType: o?.contentType ?? "json", delaySeconds: o?.delaySeconds }); },
    async sendBatch(msgs, o) { for (const m of msgs) messages.push({ body: m.body, contentType: m.contentType ?? "json", delaySeconds: m.delaySeconds ?? o?.delaySeconds }); },
    expectSent(match) {
      const hit = match === undefined ? messages[0] : messages.find((m) => subset(m.body, match));
      if (!hit) throw new Error(`fakeQueue(${name}): no message matching ${JSON.stringify(match)}; sent: ${JSON.stringify(messages.map((m) => m.body))}`);
      return hit;
    },
    expectNoneSent() { if (messages.length) throw new Error(`fakeQueue(${name}): expected nothing sent, got ${messages.length}`); },
    clear() { messages.length = 0; },
    async deliver(consumer, o = {}) {
      if (!consumer.queue) throw new Error("deliver: consumer has no queue() handler");
      const batch = createMessageBatch<T>(o.queueName ?? name, messages.map((m, i) => ({ id: `msg-${i}`, timestamp: new Date(), body: m.body, attempts: 1 })));
      const ctx = createExecutionContext();
      await consumer.queue(batch, { ...(env as Env), ...o.env }, ctx);
      return (await getQueueResult(batch, ctx)) as never;
    },
  };
}

// ---- fake Workflow binding -------------------------------------------------------------------------------------------

export interface FakeWorkflowInstance<P = unknown> { id: string; params: P; status: string; output?: unknown; pausedOrTerminated?: "paused" | "terminated" }
export interface FakeWorkflow<P = unknown> {
  create(opts?: { id?: string; params?: P }): Promise<FakeInstanceHandle<P>>;
  createBatch(batch: { id?: string; params?: P }[]): Promise<FakeInstanceHandle<P>[]>;
  get(id: string): Promise<FakeInstanceHandle<P>>;
  /** Instances created so far, in order. */
  readonly created: FakeWorkflowInstance<P>[];
  expectCreated(match?: Partial<P>): FakeWorkflowInstance<P>;
  expectNoneCreated(): void;
  clear(): void;
}
interface FakeInstanceHandle<P> { id: string; status(): Promise<{ status: string; output?: unknown }>; pause(): Promise<void>; resume(): Promise<void>; terminate(): Promise<void>; restart(): Promise<void>; sendEvent(e: { type: string; payload: unknown }): Promise<void> }
export function fakeWorkflow<P = unknown>(name = "test-workflow"): FakeWorkflow<P> {
  const created: FakeWorkflowInstance<P>[] = []; let n = 0;
  const handle = (inst: FakeWorkflowInstance<P>): FakeInstanceHandle<P> => ({
    id: inst.id,
    status: async () => ({ status: inst.status, output: inst.output }),
    pause: async () => { inst.status = "paused"; }, resume: async () => { inst.status = "running"; },
    terminate: async () => { inst.status = "terminated"; }, restart: async () => { inst.status = "queued"; },
    sendEvent: async () => {},
  });
  const add = (o?: { id?: string; params?: P }) => { const i: FakeWorkflowInstance<P> = { id: o?.id ?? `${name}-${++n}`, params: o?.params as P, status: "queued" }; created.push(i); return handle(i); };
  const subset = (a: any, w: any): boolean => (w && typeof w === "object" ? a && Object.entries(w).every(([k, v]) => subset(a[k], v)) : a === w);
  return {
    created,
    create: async (o) => add(o), createBatch: async (b) => b.map(add),
    get: async (id) => { const i = created.find((x) => x.id === id); if (!i) throw new Error(`fakeWorkflow(${name}): unknown instance ${id}`); return handle(i); },
    expectCreated(match) {
      const hit = match === undefined ? created[0] : created.find((i) => subset(i.params, match));
      if (!hit) throw new Error(`fakeWorkflow(${name}): no instance matching ${JSON.stringify(match)}; created: ${JSON.stringify(created.map((i) => i.params))}`);
      return hit;
    },
    expectNoneCreated() { if (created.length) throw new Error(`fakeWorkflow(${name}): expected none, got ${created.length}`); },
    clear() { created.length = 0; },
  };
}
