import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { builtinConventions } from "../src/conventions/index.js";
import { runConventions } from "../src/generate.js";
import { addDo, doTemplate, editWrangler } from "../src/add-do.js";
import { backoffDelay, connectChannel } from "../src/client-realtime.js";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class { ctx: unknown; env: unknown; constructor(ctx: unknown, env: unknown) { this.ctx = ctx; this.env = env; } },
}));
const { HibernatingRoom, SqlDO, applyMigrations, defineDO, doStub, sqlTag } = await import("../src/modules/realtime.js");

// ---- a fake Durable Object runtime: sockets keep their attachment across "evictions" (a new room instance on the same state) ----
class FakeSocket {
  sent: string[] = []; closed?: { code?: number; reason?: string }; attachment: unknown = null; tags: string[] = [];
  send(d: string) { if (this.closed) throw new Error("closed"); this.sent.push(d); }
  close(code?: number, reason?: string) { this.closed = { code, reason }; }
  serializeAttachment(a: unknown) { this.attachment = structuredClone(a); }
  deserializeAttachment() { return this.attachment === null ? null : structuredClone(this.attachment); }
  frames() { return this.sent.map((s) => JSON.parse(s)); }
}
function fakeState() {
  const kv = new Map<string, unknown>();
  const sockets: FakeSocket[] = [];
  let alarm: number | null = null;
  const timestamps = new Map<FakeSocket, Date>();
  const db = new DatabaseSync(":memory:");
  const sql = { exec: (q: string, ...p: unknown[]) => { const st = db.prepare(q); const rows = /^\s*(select|pragma)/i.test(q) ? (st.all(...(p as never[])) as unknown[]) : (st.run(...(p as never[])), []); return { toArray: () => rows }; } };
  const state = {
    sockets, kv, timestamps, db,
    get alarm() { return alarm; },
    storage: {
      sql,
      get: async (k: string) => kv.get(k), put: async (k: string, v: unknown) => { kv.set(k, structuredClone(v)); },
      getAlarm: async () => alarm, setAlarm: async (t: number) => { alarm = t; },
      transactionSync: <T>(fn: () => T) => { db.exec("BEGIN"); try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; } },
    },
    blockConcurrencyWhile: async (fn: () => Promise<unknown>) => { await fn(); },
    acceptWebSocket: (ws: FakeSocket, tags: string[] = []) => { ws.tags = tags; sockets.push(ws); },
    getWebSockets: (tag?: string) => sockets.filter((s) => !s.closed && (!tag || s.tags.includes(tag))),
    setWebSocketAutoResponse: vi.fn(),
    getWebSocketAutoResponseTimestamp: (ws: FakeSocket) => timestamps.get(ws) ?? null,
  };
  return state;
}
type State = ReturnType<typeof fakeState>;
const asCtx = (s: State) => s as unknown as DurableObjectState;

const RealResponse = globalThis.Response;
beforeEach(() => {
  let last: FakeSocket;
  vi.stubGlobal("WebSocketPair", function () { const c = new FakeSocket(), s = new FakeSocket(); last = s; return { 0: c, 1: s }; });
  vi.stubGlobal("WebSocketRequestResponsePair", class { constructor(public req: string, public res: string) {} });
  // node's Response refuses status 101; keep `instanceof Response` working
  vi.stubGlobal("Response", class extends RealResponse { constructor(b?: BodyInit | null, init?: ResponseInit & { webSocket?: unknown }) { super(b, init?.status === 101 ? { ...init, status: 200 } : init); if (init?.status === 101) Object.defineProperty(this, "status", { value: 101 }); (this as any).webSocket = init?.webSocket; } });
  (globalThis as any).__lastSocket = () => last!;
});
afterEach(() => { vi.unstubAllGlobals(); });
const lastSocket = () => (globalThis as any).__lastSocket() as FakeSocket;

const upgrade = (qs = "") => new Request("http://x/room" + qs, { headers: { Upgrade: "websocket" } });
async function connect(room: InstanceType<typeof HibernatingRoom>, qs = "") {
  const res = await room.fetch(upgrade(qs));
  const ws = lastSocket();
  return { res, ws, hello: ws.frames().find((f) => f.type === "$hello") };
}

class Chat extends HibernatingRoom<unknown, { name: string }, { say: { text: string } }> {
  static options = { history: 3, idleTimeoutMs: 1000 };
  authorize(req: Request) {
    const name = new URL(req.url).searchParams.get("name");
    return name === "banned" ? new Response("no", { status: 403 }) : { meta: { name: name ?? "anon" }, tags: ["room"] };
  }
  messages = { say: (c: { meta: { name: string } }, d: { text: string }) => this.broadcast("say", { name: c.meta.name, text: d.text }).then(() => {}) };
}

describe("HibernatingRoom: connect, presence, broadcast", () => {
  it("non-upgrade -> 426; authorize() can refuse", async () => {
    const room = new Chat(asCtx(fakeState()), {});
    expect((await room.fetch(new Request("http://x/room"))).status).toBe(426);
    expect((await room.fetch(upgrade("?name=banned"))).status).toBe(403);
  });
  it("$hello carries id, signed token, seq and current presence; joins are announced to others only", async () => {
    const st = fakeState(); const room = new Chat(asCtx(st), {});
    const a = await connect(room, "?name=ada");
    expect(a.res.status).toBe(101);
    expect(a.hello.data).toMatchObject({ resumed: false, seq: 0, presence: [{ meta: { name: "ada" }, tags: ["room"] }] });
    expect(a.hello.data.token).toMatch(/^[0-9a-f-]{36}\.[0-9a-f]{64}$/);
    expect(a.ws.frames().filter((f) => f.type === "$presence")).toEqual([]);
    const b = await connect(room, "?name=bob");
    expect(a.ws.frames().at(-1)).toEqual({ type: "$presence", data: { op: "join", id: b.hello.data.id, meta: { name: "bob" } } });
    expect(b.hello.data.presence.map((p: any) => p.meta.name).sort()).toEqual(["ada", "bob"]);
    await room.webSocketClose(b.ws as never, 1000, "bye");
    expect(a.ws.frames().at(-1).data).toMatchObject({ op: "leave", id: b.hello.data.id });
  });
  it("typed handlers run; broadcast is sequenced, reaches every socket, honours tag/except", async () => {
    const st = fakeState(); const room = new Chat(asCtx(st), {});
    const a = await connect(room, "?name=ada"); const b = await connect(room, "?name=bob");
    await room.webSocketMessage(a.ws as never, JSON.stringify({ type: "say", data: { text: "hi" } }));
    for (const w of [a.ws, b.ws]) expect(w.frames().at(-1)).toEqual({ type: "say", data: { name: "ada", text: "hi" }, seq: 1 });
    await room.broadcast("note", 1, { except: b.hello.data.id });
    expect(a.ws.frames().at(-1).type).toBe("note"); expect(b.ws.frames().at(-1).type).toBe("say");
    await room.broadcast("t", 1, { tag: "nobody" });
    expect(a.ws.frames().at(-1).type).toBe("note");
    expect(st.kv.get("$rt:stream")).toMatchObject({ seq: 3 });
  });
  it("bad frames: non-JSON -> onMessage as $raw; oversize -> $error; handler throw -> $error, not a crash", async () => {
    const seen: unknown[] = [];
    class R extends Chat { static options = { maxMessageBytes: 20 }; onMessage(_c: never, m: unknown) { seen.push(m); } messages = { say: () => { throw new Error("boom"); } }; }
    vi.spyOn(console, "error").mockImplementation(() => {});
    const room = new R(asCtx(fakeState()), {});
    const a = await connect(room, "?name=ada");
    await room.webSocketMessage(a.ws as never, "not json");
    expect(seen).toEqual([{ type: "$raw", data: "not json" }]);
    await room.webSocketMessage(a.ws as never, "x".repeat(50));
    expect(a.ws.frames().at(-1)).toEqual({ type: "$error", data: { message: "message too large" } });
    await room.webSocketMessage(a.ws as never, JSON.stringify({ type: "say" }));
    expect(a.ws.frames().at(-1)).toEqual({ type: "$error", data: { message: "internal error" } });
  });
  it("client-sent `$`-types never reach `messages` handlers", async () => {
    const seen: unknown[] = [];
    class R extends Chat { messages = { $hello: () => seen.push("handler") } as never; onMessage(_c: never, m: { type: string }) { seen.push(m.type); } }
    const room = new R(asCtx(fakeState()), {});
    const a = await connect(room, "?name=a");
    await room.webSocketMessage(a.ws as never, JSON.stringify({ type: "$hello" }));
    expect(seen).toEqual(["$hello"]);
  });
});

describe("HibernatingRoom: hibernation (eviction simulation)", () => {
  it("a NEW instance on the same state serves the existing sockets: attachment, presence, seq and history survive", async () => {
    const st = fakeState();
    const room1 = new Chat(asCtx(st), {});
    const a = await connect(room1, "?name=ada"); const b = await connect(room1, "?name=bob");
    await room1.webSocketMessage(a.ws as never, JSON.stringify({ type: "say", data: { text: "before" } }));
    // --- eviction: every in-memory field is gone; only ctx (sockets + storage) remains ---
    const room2 = new Chat(asCtx(st), {});
    expect(room2).not.toBe(room1);
    await room2.webSocketMessage(b.ws as never, JSON.stringify({ type: "say", data: { text: "after" } }));
    expect(a.ws.frames().at(-1)).toEqual({ type: "say", data: { name: "bob", text: "after" }, seq: 2 }); // meta from the attachment, seq continued
    expect(room2.presence().map((p) => p.meta.name).sort()).toEqual(["ada", "bob"]);
    // and resume still replays history that only the old instance ever saw
    const c = await connect(room2, `?name=ada&resume=${encodeURIComponent(a.hello.data.token)}&since=0`);
    expect(c.hello.data.resumed).toBe(true);
    expect(c.ws.frames().filter((f) => f.type === "say").map((f) => f.data.text)).toEqual(["before", "after"]);
  });
  it("alarm: schedules while sockets exist, closes idle ones 1001 and stops rescheduling when empty", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    const st = fakeState(); const room = new Chat(asCtx(st), {});
    const a = await connect(room, "?name=ada"); const b = await connect(room, "?name=bob");
    expect(st.alarm).toBe(1_000_000 + 60_000);
    vi.setSystemTime(1_000_000 + 900);
    st.timestamps.set(b.ws, new Date(1_000_000 + 800)); // b answered a ping (auto-response) recently, a did not message
    vi.setSystemTime(1_000_000 + 1500);
    await room.alarm();
    expect(a.ws.closed?.code).toBe(1001); expect(b.ws.closed).toBeUndefined();
    vi.setSystemTime(1_000_000 + 10_000);
    await room.alarm();
    expect(b.ws.closed?.code).toBe(1001);
    const before = st.alarm;
    await room.alarm();
    expect(st.alarm).toBe(before); // nothing left -> not pushed out again
    vi.useRealTimers();
  });
  it("onAlarm()'s returned timestamp is honoured", async () => {
    class R extends Chat { static options = { heartbeatMs: 0 }; onAlarm() { return 5000; } }
    const st = fakeState(); const room = new R(asCtx(st), {});
    await room.alarm();
    expect(st.alarm).toBe(5000);
  });
});

describe("HibernatingRoom: resume", () => {
  it("replays missed messages (tag-filtered, except-filtered), keeps identity, no duplicate join", async () => {
    const st = fakeState(); const room = new Chat(asCtx(st), {});
    const a = await connect(room, "?name=ada"); const b = await connect(room, "?name=bob");
    const id = b.hello.data.id;
    await room.broadcast("m1", 1); await room.broadcast("priv", 2, { tag: "other" }); await room.broadcast("m3", 3, { except: id }); await room.broadcast("m4", 4);
    await room.webSocketClose(b.ws as never, 1006, "");
    a.ws.sent.length = 0;
    const b2 = await connect(room, `?name=bob&resume=${encodeURIComponent(b.hello.data.token)}&since=1`);
    expect(b2.hello.data).toMatchObject({ resumed: true, id });
    // history=3 keeps seq 2..4; since=1 -> seq 1 fell out? (1 < 2-1 false) so no gap; replay: priv filtered (tag), m3 filtered (except) -> m4
    expect(b2.hello.data.gap).toBe(false);
    expect(b2.ws.frames().filter((f) => f.seq).map((f) => f.type)).toEqual(["m4"]);
    expect(a.ws.frames().filter((f) => f.type === "$presence").map((f) => f.data.op)).toEqual(["join"]); // left+rejoin after close, exactly one join
  });
  it("gap=true when history no longer covers `since`", async () => {
    const room = new Chat(asCtx(fakeState()), {});
    const a = await connect(room, "?name=ada");
    for (let i = 0; i < 6; i++) await room.broadcast("m", i);
    const r = await connect(room, `?name=ada&resume=${encodeURIComponent(a.hello.data.token)}&since=1`);
    expect(r.hello.data.gap).toBe(true);
  });
  it("replaces a still-registered old socket of the same identity without announcing a leave", async () => {
    const st = fakeState(); const room = new Chat(asCtx(st), {});
    const a = await connect(room, "?name=ada"); const o = await connect(room, "?name=obs");
    o.ws.sent.length = 0;
    const a2 = await connect(room, `?name=ada&resume=${encodeURIComponent(a.hello.data.token)}&since=0`);
    expect(a.ws.closed?.reason).toBe("replaced");
    await room.webSocketClose(a.ws as never, 1000, "replaced");
    expect(o.ws.frames().filter((f) => f.type === "$presence")).toEqual([]);
    expect(a2.hello.data.id).toBe(a.hello.data.id);
  });
  it("a forged or truncated token does not resume (fresh identity)", async () => {
    const room = new Chat(asCtx(fakeState()), {});
    const a = await connect(room, "?name=ada");
    for (const bad of [a.hello.data.id + ".00", "garbage", a.hello.data.token.slice(0, -1) + (a.hello.data.token.endsWith("0") ? "1" : "0"), ""]) {
      const r = await connect(room, `?name=eve&resume=${encodeURIComponent(bad)}&since=0`);
      expect(r.hello.data.resumed).toBe(false);
      expect(r.hello.data.id).not.toBe(a.hello.data.id);
    }
  });
  it("tokens are per-room: another room (other HMAC key) rejects them", async () => {
    const r1 = new Chat(asCtx(fakeState()), {}), r2 = new Chat(asCtx(fakeState()), {});
    const a = await connect(r1, "?name=ada");
    expect((await connect(r2, `?name=ada&resume=${encodeURIComponent(a.hello.data.token)}`)).hello.data.resumed).toBe(false);
  });
});

describe("SQL helpers: migrations by version", () => {
  it("applies each once, in order; re-running is a no-op; a failing migration is not recorded and retried next time", () => {
    const st = fakeState(); const s = st.storage as unknown as DurableObjectStorage;
    expect(applyMigrations(s, ["CREATE TABLE t (n INTEGER)", (sql) => { sql.exec("INSERT INTO t VALUES (1)"); }])).toBe(2);
    expect(applyMigrations(s, ["CREATE TABLE t (n INTEGER)", () => { throw new Error("must not rerun"); }])).toBe(2);
    expect(() => applyMigrations(s, ["x", "x", "SELECT * FROM nope"])).toThrow();
    expect(st.db.prepare("select version from cfl_migrations").get()).toEqual({ version: 2 });
    expect(applyMigrations(s, ["x", "x", "CREATE TABLE u (a)"])).toBe(3);
    expect(st.db.prepare("select count(*) c from t").get()).toEqual({ c: 1 });
  });
  it("sql tag binds parameters (injection-safe) and `.one` returns the first row", () => {
    const st = fakeState(); const sql = sqlTag(st.storage.sql as never);
    sql`CREATE TABLE u (name TEXT)`;
    sql`INSERT INTO u VALUES (${"x'); DROP TABLE u; --"})`;
    expect(sql.one<{ name: string }>`SELECT name FROM u WHERE name = ${"x'); DROP TABLE u; --"}`).toEqual({ name: "x'); DROP TABLE u; --" });
    expect(sql<{ c: number }>`SELECT count(*) AS c FROM u`[0].c).toBe(1);
    expect(sql.one`SELECT * FROM u WHERE name = ${"none"}`).toBeUndefined();
  });
  it("SqlDO / defineDO run static migrations at construction", () => {
    const st = fakeState();
    class Counter extends SqlDO { static migrations = ["CREATE TABLE hits (n INTEGER)", "INSERT INTO hits VALUES (7)"]; }
    const c = new Counter(asCtx(st), {});
    expect(c.sql.one<{ n: number }>`SELECT n FROM hits`).toEqual({ n: 7 });
    const st2 = fakeState();
    class D extends defineDO({ migrations: ["CREATE TABLE z (a)"] }) {}
    expect(new D(asCtx(st2), {}).sql`SELECT count(*) AS c FROM z`).toEqual([{ c: 0 }]);
  });
  it("HibernatingRoom static migrations + doStub routing", async () => {
    class R extends Chat { static migrations = ["CREATE TABLE seen (n)"]; }
    const r = new R(asCtx(fakeState()), {});
    expect(r.sql`SELECT count(*) AS c FROM seen`).toEqual([{ c: 0 }]);
    const stub = { fetch: vi.fn(async () => new RealResponse("ok")) };
    const ns = { idFromName: vi.fn((n: string) => "id:" + n), get: vi.fn(() => stub) };
    const res = await doStub(() => ns as never).fetch("lobby", new Request("http://x"));
    expect(await res.text()).toBe("ok"); expect(ns.idFromName).toHaveBeenCalledWith("lobby");
  });
});

// ---- client ----
class FakeWS {
  static all: FakeWS[] = [];
  readyState = 0; sent: string[] = []; onopen?: () => void; onmessage?: (e: { data: string }) => void; onclose?: () => void; onerror?: () => void;
  constructor(public url: string, public protocols?: unknown) { FakeWS.all.push(this); }
  send(d: string) { this.sent.push(d); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  recv(o: unknown) { this.onmessage?.({ data: typeof o === "string" ? o : JSON.stringify(o) }); }
  drop() { this.readyState = 3; this.onclose?.(); }
}
const hello = (extra = {}) => ({ type: "$hello", data: { id: "me", token: "me.sig", seq: 0, presence: [], resumed: false, ...extra } });
const mk = (o = {}) => connectChannel("https://app.test/api/rooms/x", { WebSocket: FakeWS as never, random: () => 0, pingMs: 0, ...o });

describe("connectChannel", () => {
  beforeEach(() => { FakeWS.all = []; vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("backoffDelay: exponential, capped, jittered downwards", () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((n) => backoffDelay(n, { base: 500, max: 4000, jitter: 0 }))).toEqual([500, 1000, 2000, 4000, 4000, 4000, 4000]);
    expect(backoffDelay(1, { base: 500, jitter: 0.5 }, () => 1)).toBe(500);
    expect(backoffDelay(1, { base: 500, jitter: 0.5 }, () => 0)).toBe(1000);
  });
  it("connects over ws(s) with params, reports status, dispatches by type, unsubscribes", () => {
    const ch = mk({ params: { name: "ada", tag: ["a", "b"] } });
    const ws = FakeWS.all[0];
    expect(ws.url).toBe("wss://app.test/api/rooms/x?name=ada&tag=a&tag=b");
    const st: string[] = []; ch.onStatus((s) => st.push(s));
    expect(ch.status).toBe("connecting");
    ws.open(); expect(st).toEqual(["open"]);
    const got: unknown[] = [], all: string[] = [];
    const off = ch.on("chat", (d) => got.push(d)); ch.on("*", (_d, e) => all.push(e.type));
    ws.recv(hello()); ws.recv({ type: "chat", data: 1, seq: 1 }); off(); ws.recv({ type: "chat", data: 2, seq: 2 });
    expect(got).toEqual([1]); expect(all).toEqual(["$hello", "chat", "chat"]);
    expect(ch.id).toBe("me"); expect(ch.lastSeq).toBe(2);
  });
  it("reconnects with backoff, resumes with token + since, resets the attempt counter on $hello", () => {
    const ch = mk({ backoff: { base: 100, max: 1000, jitter: 0 } });
    const st: string[] = []; ch.onStatus((s) => st.push(s));
    let ws = FakeWS.all[0]; ws.open(); ws.recv(hello()); ws.recv({ type: "m", seq: 5 });
    ws.drop();
    expect(ch.status).toBe("reconnecting");
    vi.advanceTimersByTime(99); expect(FakeWS.all).toHaveLength(1);
    vi.advanceTimersByTime(1); expect(FakeWS.all).toHaveLength(2);
    ws = FakeWS.all[1];
    expect(new URL(ws.url).searchParams.get("resume")).toBe("me.sig"); expect(new URL(ws.url).searchParams.get("since")).toBe("5");
    ws.drop(); vi.advanceTimersByTime(199); expect(FakeWS.all).toHaveLength(2); // attempt 1 -> 200ms (no hello yet, so no reset)
    vi.advanceTimersByTime(1); expect(FakeWS.all).toHaveLength(3);
    ws = FakeWS.all[2]; ws.open(); ws.recv(hello({ resumed: true })); ws.drop();
    vi.advanceTimersByTime(100); expect(FakeWS.all).toHaveLength(4); // reset -> base delay again
    expect(st).toEqual(["open", "reconnecting", "open", "reconnecting", "open", "reconnecting"].slice(0, st.length));
  });
  it("a socket that opens but is refused does not reset backoff", () => {
    mk({ backoff: { base: 100, jitter: 0 } });
    FakeWS.all[0].open(); FakeWS.all[0].drop();
    vi.advanceTimersByTime(100); FakeWS.all[1].open(); FakeWS.all[1].drop();
    vi.advanceTimersByTime(199); expect(FakeWS.all).toHaveLength(2);
    vi.advanceTimersByTime(1); expect(FakeWS.all).toHaveLength(3);
  });
  it("queues while offline (bounded), flushes in order on open", () => {
    const ch = mk({ queueLimit: 2 });
    ch.send("a"); ch.send("b"); ch.send("c");
    const ws = FakeWS.all[0]; ws.open();
    expect(ws.sent.map((s) => JSON.parse(s).type)).toEqual(["b", "c"]);
    ch.send("d"); expect(JSON.parse(ws.sent.at(-1)!).type).toBe("d");
  });
  it("heartbeat: pings, and reconnects when no frame (incl. pong) arrives in time", () => {
    const ch = mk({ pingMs: 1000, pongTimeoutMs: 500, backoff: { base: 10, jitter: 0 } });
    const ws = FakeWS.all[0]; ws.open();
    vi.advanceTimersByTime(1000); expect(ws.sent).toEqual(["ping"]);
    ws.recv("pong"); vi.advanceTimersByTime(600); expect(FakeWS.all).toHaveLength(1); // pong cleared the deadline
    vi.advanceTimersByTime(400); expect(ws.sent).toEqual(["ping", "ping"]);
    vi.advanceTimersByTime(500); // no pong
    expect(ch.status).toBe("reconnecting");
    vi.advanceTimersByTime(10); expect(FakeWS.all).toHaveLength(2);
  });
  it("maxRetries gives up -> closed; close() stops reconnecting and drops sends", () => {
    const ch = mk({ maxRetries: 2, backoff: { base: 10, jitter: 0 } });
    FakeWS.all[0].drop(); vi.advanceTimersByTime(10); FakeWS.all[1].drop(); vi.advanceTimersByTime(20); FakeWS.all[2].drop();
    expect(ch.status).toBe("closed"); vi.advanceTimersByTime(10_000); expect(FakeWS.all).toHaveLength(3);
    const c2 = mk(); c2.close(); c2.send("x"); vi.advanceTimersByTime(60_000);
    expect(c2.status).toBe("closed"); expect(FakeWS.all).toHaveLength(4);
  });
  it("ignores late events from a superseded socket and malformed frames", () => {
    const ch = mk({ backoff: { base: 10, jitter: 0 } });
    const got: unknown[] = []; ch.on("*", (_d, e) => got.push(e.type));
    const old = FakeWS.all[0]; old.open(); old.drop(); vi.advanceTimersByTime(10);
    old.recv({ type: "ghost" }); FakeWS.all[1].open(); FakeWS.all[1].recv("{nope"); FakeWS.all[1].recv({ nottype: 1 });
    expect(got).toEqual([]);
  });
});

// ---- convention + CLI ----
const here = fileURLToPath(new URL(".", import.meta.url));
const tmp = (files: Record<string, string>) => {
  const root = mkdtempSync(join(here, ".tmp-rt-"));
  for (const [f, s] of Object.entries(files)) { mkdirSync(join(root, f, ".."), { recursive: true }); writeFileSync(join(root, f), s); }
  return root;
};
const gen = (files: Record<string, string>) => runConventions(tmp(files), undefined, builtinConventions);

describe("server/do convention", () => {
  it("zero bytes when unused", () => {
    const g = gen({ "server/api/hello.ts": "" });
    expect(Object.keys(g.files)).toEqual(["app.ts", "routes.ts"]);
  });
  it("re-exports classes from the Worker entry file and types the namespace helpers", () => {
    const g = gen({ "server/do/chat.ts": "export default class X {}", "server/do/match-room.ts": `export default class Y {}\nexport const binding = "MATCHES";\nexport const className = "MatchRoom";` });
    expect(g.files["do-classes.ts"]).toContain(`export { default as Chat } from "../server/do/chat";`);
    expect(g.files["do-classes.ts"]).toContain(`export { default as MatchRoom } from "../server/do/match-room";`);
    expect(g.files["do.ts"]).toContain(`"chat": doStub(() => (env as unknown as Env).CHAT`);
    expect(g.files["do.ts"]).toContain(`"match-room": doStub(() => (env as unknown as Env).MATCHES`);
  });
  it("two files exporting the same class name is a build error", () => {
    expect(() => gen({ "server/do/a.ts": `export default class A {}\nexport const className = "Z";`, "server/do/b.ts": `export default class B {}\nexport const className = "Z";` })).toThrow(/both export Durable Object class "Z"/);
  });
  it("doctor checks: binding, class_name, SQLite migration (legacy new_classes flagged)", () => {
    const g = gen({ "server/do/chat.ts": "export default class C {}" });
    const run = (w: object) => g.checks.flatMap((c) => c(w as never));
    expect(run({ durable_objects: { bindings: [{ name: "CHAT", class_name: "Chat" }] }, migrations: [{ tag: "v1", new_sqlite_classes: ["Chat"] }] })).toEqual([]);
    expect(run({})).toEqual([expect.stringMatching(/no binding "CHAT".*cf-lite add do chat/), expect.stringMatching(/no wrangler migration creates class "Chat"/)]);
    expect(run({ durable_objects: { bindings: [{ name: "CHAT", class_name: "Other" }] }, migrations: [{ tag: "v1", new_sqlite_classes: ["Chat"] }] })[0]).toMatch(/class_name "Other"/);
    expect(run({ durable_objects: { bindings: [{ name: "CHAT", class_name: "Chat" }] }, migrations: [{ tag: "v1", new_classes: ["Chat"] }] })[0]).toMatch(/KV-backed/);
  });
  it("a file without a default export is reported, not wired", () => {
    const g = gen({ "server/do/chat.ts": "export class C {}" });
    expect(g.files["do-classes.ts"]).not.toContain("export {");
    expect(g.checks.flatMap((c) => c({} as never))[0]).toMatch(/no default export/);
  });
});

describe("cf-lite add do", () => {
  it("adds binding + SQLite migration to an empty config, idempotently, keeping comments", () => {
    const src = `{\n  // my app\n  "name": "x",\n}\n`;
    const r = editWrangler(src, "chat");
    expect(r.text).toContain(`"durable_objects": { "bindings": [{ "name": "CHAT", "class_name": "Chat" }] }`);
    expect(r.text).toContain(`{ "tag": "v1", "new_sqlite_classes": ["Chat"] }`);
    expect(r.text).toContain("// my app");
    expect(editWrangler(r.text, "chat").text).toBe(r.text);
  });
  it("appends to existing arrays with the next migration tag", () => {
    const src = `{ "durable_objects": { "bindings": [{ "name": "A", "class_name": "A" }] }, "migrations": [{ "tag": "v1", "new_sqlite_classes": ["A"] }, { "tag": "v2", "renamed_classes": [] }] }`;
    const r = editWrangler(src, "match-room");
    expect(r.text).toContain(`{ "name": "MATCH_ROOM", "class_name": "MatchRoom" }`);
    expect(r.text).toContain(`{ "tag": "v3", "new_sqlite_classes": ["MatchRoom"] }`);
    expect(JSON.parse(r.text).migrations).toHaveLength(3);
  });
  it("writes the file once, never overwrites, rejects bad names", () => {
    const dir = tmp({ "package.json": "{}", "wrangler.jsonc": "{}" });
    const logs: string[] = [];
    expect(addDo(dir, "chat", (m) => logs.push(m)).changed).toEqual(["server/do/chat.ts", "wrangler.jsonc"]);
    expect(addDo(dir, "chat", (m) => logs.push(m)).changed).toEqual([]);
    expect(logs.join("\n")).toMatch(/keep\s+server\/do\/chat\.ts/);
    expect(() => addDo(dir, "../evil")).toThrow(/name must be/);
    expect(doTemplate("my-room")).toContain("class MyRoom extends HibernatingRoom");
  });
});
