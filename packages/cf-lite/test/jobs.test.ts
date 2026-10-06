import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { builtinConventions } from "../src/conventions/index.js";
import { runConventions } from "../src/generate.js";
import { dispatchCron } from "../src/modules/cron.js";
import { addressMatches, dispatchEmail, pickEmailRoute } from "../src/modules/email.js";
import { backoff, defineQueue, dispatchQueue, queueProducer } from "../src/modules/queue.js";
import { workflowProducer } from "../src/modules/workflow.js";

vi.mock("cloudflare:workers", () => ({ waitUntil: vi.fn() }));

const here = fileURLToPath(new URL(".", import.meta.url));
const tmp = (files: Record<string, string>) => {
  const root = mkdtempSync(join(here, ".tmp-jobs-"));
  for (const [f, s] of Object.entries(files)) { mkdirSync(join(root, f, ".."), { recursive: true }); writeFileSync(join(root, f), s); }
  return root;
};
const gen = (files: Record<string, string>) => runConventions(tmp(files), undefined, builtinConventions);
const ctx = () => ({ waitUntil: vi.fn(), passThroughOnException: vi.fn() }) as unknown as ExecutionContext;

describe("zero bytes when unused", () => {
  it("no job conventions -> no handlers.ts, no queues/workflows files", () => {
    const g = gen({ "server/api/hello.ts": "" });
    expect(Object.keys(g.files)).toEqual(["app.ts", "routes.ts"]);
    expect(g.checks).toEqual([]);
    expect(g.files["app.ts"]).not.toMatch(/cron|queue|workflow/i);
  });
});

describe("cron convention", () => {
  const cron = (s: string) => `export const schedule = ${s};\nexport default async () => {};\n`;
  it("generates one scheduled() dispatcher over every file", () => {
    const g = gen({ "server/cron/a.ts": cron(`"*/15 * * * *"`), "server/cron/b.ts": cron(`["0 0 * * *", "0 12 * * *"]`) });
    const h = g.files["handlers.ts"];
    expect(h).toContain(`import { dispatchCron } from "cf-lite/modules/cron";`);
    expect(h).toContain(`import c0 from "../server/cron/a";`);
    expect(h).toContain(`{ name: "b", schedules: ["0 0 * * *","0 12 * * *"], run: c1 }`);
    expect(h).toMatch(/scheduled: \(ev, env, ctx\) => dispatchCron\(/);
    expect(h).not.toContain("queue:");
  });
  it("doctor checks: wrangler triggers.crons vs files, both directions", () => {
    const g = gen({ "server/cron/a.ts": cron(`"*/15 * * * *"`) });
    const run = (w: object) => g.checks.flatMap((c) => c(w as never));
    expect(run({ triggers: { crons: ["*/15 * * * *"] } })).toEqual([]);
    expect(run({})[0]).toMatch(/lacks \["\*\/15 \* \* \* \*"\]/);
    expect(run({ triggers: { crons: ["*/15 * * * *", "1 1 * * *"] } })[0]).toMatch(/no server\/cron file declares/);
  });
  it("a file without schedule/default is reported, not wired", () => {
    const g = gen({ "server/cron/bad.ts": "export const nothing = 1;" });
    expect(g.files["handlers.ts"]).toBeUndefined();
    expect(g.checks.flatMap((c) => c({ triggers: { crons: [] } }))).toHaveLength(2);
  });
  it("dispatchCron: by expression, concurrent, failure isolated then surfaced", async () => {
    const calls: string[] = [];
    const ev = { cron: "* * * * *", scheduledTime: 0 } as ScheduledController;
    const jobs = [
      { name: "ok", schedules: ["* * * * *"], run: async () => { calls.push("ok"); } },
      { name: "boom", schedules: ["* * * * *", "0 0 * * *"], run: async () => { throw new Error("x"); } },
      { name: "other", schedules: ["0 0 * * *"], run: async () => { calls.push("other"); } },
    ];
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(dispatchCron(jobs, ev, {}, ctx())).rejects.toThrow(/1 job\(s\) failed: boom/);
    expect(calls).toEqual(["ok"]);
    err.mockRestore();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await dispatchCron(jobs, { cron: "5 5 * * *" } as ScheduledController, {}, ctx());
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("queues convention", () => {
  const files = {
    "server/queues/emails.ts": `export type Message = { to: string };\nexport default async () => {};\n`,
    "server/queues/emails-dlq.ts": `export const queue = "emails-dlq";\nexport const binding = "DLQ";\nexport default async () => {};\n`,
    "server/queues/typed.ts": `export const schema = { parse: (x: unknown) => x as { n: number } };\nexport default async () => {};\n`,
  };
  it("multiplexes by queue name and generates typed producers", () => {
    const g = gen(files);
    expect(g.files["handlers.ts"]).toContain(`queue: (batch, env, ctx) => dispatchQueue({ "emails": q0, "emails-dlq": q1, "typed": q2 }, batch, env, ctx)`);
    const q = g.files["queues.ts"];
    expect(q).toContain(`import type { Message as M0 } from "../server/queues/emails";`);
    expect(q).toContain(`"emails": queueProducer<M0>(() => (env as unknown as Env).EMAILS_QUEUE),`);
    expect(q).toContain(`"emails-dlq": queueProducer<M1>(() => (env as unknown as Env).DLQ),`);
    expect(q).toContain(`type M2 = SchemaOutput<typeof S2>;`);
    expect(q).toContain(`queueProducer<M2>(() => (env as unknown as Env).TYPED_QUEUE, S2)`);
  });
  it("checks producers and consumers against wrangler, both directions", () => {
    const g = gen(files);
    const run = (w: object) => g.checks.flatMap((c) => c(w as never));
    expect(run({}).length).toBe(6);
    const ok = { queues: { producers: [{ binding: "EMAILS_QUEUE", queue: "emails" }, { binding: "DLQ", queue: "emails-dlq" }, { binding: "TYPED_QUEUE", queue: "typed" }], consumers: [{ queue: "emails" }, { queue: "emails-dlq" }, { queue: "typed" }] } };
    expect(run(ok)).toEqual([]);
    expect(run({ queues: { ...ok.queues, consumers: [...ok.queues.consumers, { queue: "ghost" }] } })[0]).toMatch(/"ghost" but no server\/queues file/);
  });
  it("two files for one queue is an error", () => {
    expect(() => gen({ "server/queues/a.ts": `export const queue = "x";export default 1;`, "server/queues/b.ts": `export const queue = "x";export default 1;` })).toThrow(/both handle queue "x"/);
  });
  it("conflicts with a user-provided scheduled handler are not created: cron + queues compose into one handlers.ts", () => {
    const g = gen({ ...files, "server/cron/a.ts": `export const schedule = "* * * * *";export default () => {};`, "server/email/s.ts": `export const match = "s@x.com";export default () => {};` });
    const h = g.files["handlers.ts"];
    expect(h).toMatch(/scheduled:/); expect(h).toMatch(/queue:/); expect(h).toMatch(/email:/);
  });
});

describe("workflows convention", () => {
  it("re-exports classes from the entry file and generates typed producers", () => {
    const g = gen({ "server/workflows/user-onboarding.ts": `export default class X {}\n`, "server/workflows/report.ts": `export const className = "Rep";export const binding = "R";export default class Y {}` });
    expect(g.files["workflow-classes.ts"]).toContain(`export { default as UserOnboarding } from "../server/workflows/user-onboarding";`);
    expect(g.files["workflow-classes.ts"]).toContain(`export { default as Rep } from "../server/workflows/report";`);
    expect(g.files["workflows.ts"]).toContain(`"user-onboarding": workflowProducer<WorkflowParams<typeof W1>>(() => (env as unknown as Env).USER_ONBOARDING_WORKFLOW)`);
    expect(g.files["workflows.ts"]).toContain(`() => (env as unknown as Env).R)`);
    const run = (w: object) => g.checks.flatMap((c) => c(w as never));
    expect(run({}).length).toBe(2);
    expect(run({ workflows: [{ binding: "USER_ONBOARDING_WORKFLOW", class_name: "UserOnboarding", name: "a" }, { binding: "R", class_name: "Wrong", name: "b" }] })).toEqual([expect.stringMatching(/class_name "Wrong"/)]);
  });
});

describe("email convention + dispatch", () => {
  it("patterns", () => {
    expect(addressMatches("a@x.com", "A@X.com")).toBe(true);
    expect(addressMatches("*@x.com", "anyone@x.com")).toBe(true);
    expect(addressMatches("*@x.com", "a@y.com")).toBe(false);
    expect(addressMatches("sales@*", "sales@foo.org")).toBe(true);
    expect(addressMatches("*", "q@q.q")).toBe(true);
  });
  it("specific beats catch-all; none rejects", async () => {
    const run = () => {};
    const routes = [{ name: "all", run }, { name: "sup", match: ["support@x.com"], run }];
    expect(pickEmailRoute(routes, "support@x.com")?.name).toBe("sup");
    expect(pickEmailRoute(routes, "other@x.com")?.name).toBe("all");
    expect(pickEmailRoute([routes[1]], "other@x.com")).toBeUndefined();
    const setReject = vi.fn();
    await dispatchEmail([routes[1]], { to: "o@x.com", setReject } as never, {}, ctx());
    expect(setReject).toHaveBeenCalled();
  });
});

const msg = (body: unknown, attempts = 1, id = "m" + Math.random()) => ({ id, body, attempts, ack: vi.fn(), retry: vi.fn() });
const batchOf = (queue: string, messages: ReturnType<typeof msg>[]) => ({ queue, messages }) as unknown as MessageBatch<any>;

describe("defineQueue / dispatchQueue", () => {
  it("acks on success, retries the failed message only, with backoff", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = defineQueue<number>({ each: (n) => { if (n === 2) throw new Error("no"); }, retryDelay: backoff({ base: 10 }) });
    const [a, b, c] = [msg(1), msg(2, 3), msg(3)];
    await h(batchOf("q", [a, b, c]), {}, ctx());
    expect(a.ack).toHaveBeenCalled(); expect(c.ack).toHaveBeenCalled();
    expect(b.ack).not.toHaveBeenCalled();
    expect(b.retry).toHaveBeenCalledWith({ delaySeconds: 40 });
    err.mockRestore();
  });
  it("maxAttempts: onDead then ack, no more retry", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const dead = vi.fn();
    const h = defineQueue({ each: () => { throw new Error("x"); }, maxAttempts: 3, onDead: dead });
    const last = msg("z", 3), first = msg("y", 1);
    await h(batchOf("q", [first, last]), {}, ctx());
    expect(dead).toHaveBeenCalledTimes(1);
    expect(last.ack).toHaveBeenCalled(); expect(last.retry).not.toHaveBeenCalled();
    expect(first.retry).toHaveBeenCalledWith(undefined);
    err.mockRestore();
  });
  it("backoff is capped", () => {
    const f = backoff({ base: 30, factor: 2, max: 100 });
    expect([1, 2, 3, 4].map(f)).toEqual([30, 60, 100, 100]);
  });
  it("dispatch by batch.queue; unknown throws", async () => {
    const seen: string[] = [];
    const table = { a: async () => { seen.push("a"); }, b: async () => { seen.push("b"); } };
    await dispatchQueue(table, batchOf("b", []), {}, ctx());
    expect(seen).toEqual(["b"]);
    await expect(dispatchQueue(table, batchOf("zz", []), {}, ctx())).rejects.toThrow(/zz/);
  });
});

describe("producers", () => {
  it("queueProducer validates with schema and chunks sendBatch at 100", async () => {
    const q = { send: vi.fn(async () => {}), sendBatch: vi.fn(async () => {}) };
    const p = queueProducer<number>(() => q as never, { parse: (x) => { if (typeof x !== "number") throw new Error("bad"); return x; } });
    await p.send(1);
    expect(q.send).toHaveBeenCalledWith(1, undefined);
    await expect(p.send("x" as never)).rejects.toThrow("bad");
    await p.sendBatch(Array.from({ length: 250 }, (_, i) => i));
    expect(q.sendBatch.mock.calls.map((c) => (c[0] as unknown[]).length)).toEqual([100, 100, 50]);
    await expect(queueProducer(() => undefined).send(1)).rejects.toThrow(/binding is missing/);
  });
  it("workflowProducer maps create/get/status", async () => {
    const inst = { id: "i", status: vi.fn(async () => ({ status: "running" })) };
    const w = { create: vi.fn(async () => inst), createBatch: vi.fn(async () => [inst]), get: vi.fn(async () => inst) };
    const p = workflowProducer<{ a: number }>(() => w as never);
    await p.create({ id: "i", params: { a: 1 } });
    expect(w.create).toHaveBeenCalledWith({ id: "i", params: { a: 1 } });
    expect(await p.status("i")).toEqual({ status: "running" });
    expect(() => workflowProducer(() => undefined).get("x")).toThrow(/binding is missing/);
  });
});

describe("after()", () => {
  it("binds to ctx.waitUntil (explicit) or cloudflare:workers waitUntil (ambient); captures errors", async () => {
    const { after, setAfterErrorHandler } = await import("../src/modules/after.js");
    const { waitUntil } = await import("cloudflare:workers");
    const errors: unknown[] = [];
    setAfterErrorHandler((e) => errors.push(e));
    const ran: string[] = [];
    let captured: Promise<unknown> | undefined;
    after(async () => { ran.push("ctx"); }, { waitUntil: (p) => { captured = p; } });
    await captured;
    expect(ran).toEqual(["ctx"]);
    after(() => { throw new Error("late"); });
    const p = (waitUntil as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as Promise<unknown>;
    await p;
    expect((errors[0] as Error).message).toBe("late");
  });
});

import { addJob, editWrangler, insertIntoArray } from "../src/add-jobs.js";
import { readFileSync } from "node:fs";

describe("cf-lite add cron|queue|workflow", () => {
  const W = `{\n  // keep me\n  "name": "x",\n  "main": "server/worker.ts",\n}\n`;
  it("inserts into absent keys, keeps comments, is idempotent", () => {
    let t = editWrangler(W, "cron", "a", { schedule: "0 * * * *" }).text;
    expect(t).toContain(`"triggers": { "crons": ["0 * * * *"] }`);
    expect(t).toContain("// keep me");
    expect(editWrangler(t, "cron", "a", { schedule: "0 * * * *" }).text).toBe(t);
    t = editWrangler(t, "cron", "b", { schedule: "1 * * * *" }).text;
    expect(t).toContain(`["0 * * * *", "1 * * * *"]`);
    const q = editWrangler(W, "queue", "emails").text;
    expect(q).toContain(`"binding": "EMAILS_QUEUE"`);
    expect(editWrangler(q, "queue", "emails").text).toBe(q);
    const q2 = editWrangler(q, "queue", "sms").text;
    expect(q2).toContain("SMS_QUEUE"); expect(q2.match(/"producers"/g)).toHaveLength(1);
    const w = editWrangler(W, "workflow", "user-onboarding").text;
    expect(w).toContain(`"class_name": "UserOnboarding"`);
    expect(editWrangler(w, "workflow", "user-onboarding").text).toBe(w);
    expect(insertIntoArray(`{"a":[{"x":[1]}]}`, "a", "9")).toBe(`{"a":[{"x":[1]}, 9]}`); expect(insertIntoArray(`{"a":[`, "a", "1")).toBeNull();
  });
  it("addJob scaffolds once (run twice = no diff)", () => {
    const dir = tmp({ "wrangler.jsonc": W, "package.json": "{}" });
    expect(addJob(dir, "queue", "emails").changed).toEqual(["server/queues/emails.ts", "wrangler.jsonc"]);
    const before = readFileSync(join(dir, "wrangler.jsonc"), "utf8");
    expect(addJob(dir, "queue", "emails").changed).toEqual([]);
    expect(readFileSync(join(dir, "wrangler.jsonc"), "utf8")).toBe(before);
    expect(() => addJob(dir, "cron", "../x")).toThrow();
    // the generated project passes its own convention checks
    const g = runConventions(dir, undefined, builtinConventions);
    expect(g.checks.flatMap((c) => c(JSON.parse(before.replace(/\/\/[^\n]*/g, "").replace(/,(\s*[}\]])/g, "$1"))))).toEqual([]);
  });
});

import { addWebhook } from "../src/add-webhook.js";
describe("cf-lite add webhook", () => {
  const W = `{\n  // keep me\n  "name": "x",\n  "main": "server/worker.ts",\n}\n`;
  it("scaffolds receiver + consumer + queue wiring once, and the result passes the conventions", () => {
    const dir = tmp({ "wrangler.jsonc": W, "package.json": "{}" });
    expect(addWebhook(dir).changed.sort()).toEqual(["server/api/webhooks.ts", "server/queues/cms-webhook.ts", "wrangler.jsonc"]);
    const wr = readFileSync(join(dir, "wrangler.jsonc"), "utf8");
    expect(wr).toContain(`"binding": "WEBHOOK_QUEUE", "queue": "cms-webhook"`);
    expect(wr).toContain("// keep me");
    expect(addWebhook(dir).changed).toEqual([]);
    expect(readFileSync(join(dir, "wrangler.jsonc"), "utf8")).toBe(wr);
    expect(readFileSync(join(dir, "server/api/webhooks.ts"), "utf8")).toContain("genericAdapter()");
    const g = runConventions(dir, undefined, builtinConventions);
    expect(g.checks.flatMap((c) => c(JSON.parse(wr.replace(/\/\/[^\n]*/g, "").replace(/,(\s*[}\]])/g, "$1"))))).toEqual([]);
    const gen = JSON.stringify(g);
    expect(gen).toContain("cms-webhook");
    expect(gen).toContain("WEBHOOK_QUEUE");
  });
  it("optimizely provider variant and bad provider", () => {
    const dir = tmp({ "wrangler.jsonc": W, "package.json": "{}" });
    addWebhook(dir, () => {}, { provider: "optimizely" });
    expect(readFileSync(join(dir, "server/api/webhooks.ts"), "utf8")).toMatch(/STUB[\s\S]*optimizelyVerify/);
    expect(() => addWebhook(dir, () => {}, { provider: "nope" })).toThrow(/--provider/);
  });
});
