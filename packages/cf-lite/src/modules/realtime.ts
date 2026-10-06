/**
 * `cf-lite/modules/realtime` - Durable Object presets (docs/realtime.md). Experimental tier.
 *
 *   - `HibernatingRoom`: WebSocket Hibernation API room. Per-socket state lives in the socket attachment (survives eviction),
 *     channels are hibernation tags, presence is derived from the live sockets, broadcasts carry a sequence number and a bounded
 *     history so a reconnecting client (`connectChannel`, cf-lite/client-realtime) resumes without gaps, an alarm drops dead sockets.
 *   - `defineDO` / `SqlDO`: a plain SQLite-backed Durable Object with a typed `sql` tag and migrations-by-version.
 *   - `doStub`: typed access to a namespace binding from a route (`stub.fetch(name, request)` forwards a WebSocket upgrade).
 *
 * Wire protocol (JSON text frames; control types start with `$`):
 *   server -> client  { type, data?, seq?, from? }      `$hello` {id, token, seq, presence, resumed} | `$presence` {op, id, meta} | `$error` {message}
 *   client -> server  { type, data? }                   or the literal text `ping` (answered `pong` by the runtime without waking the DO)
 */
import { DurableObject } from "cloudflare:workers";

export interface Presence<Meta = unknown> { id: string; meta: Meta; tags: string[]; joinedAt: number }

/** Wire envelope. `seq` is present on `broadcast()` messages (the resumable stream). */
export interface Envelope<T = unknown> { type: string; data?: T; seq?: number; from?: string }

export interface RoomOptions {
  /** Alarm period for the idle sweep; 0 disables the alarm. Default 60_000. */
  heartbeatMs?: number;
  /** A socket silent (no message, no `ping`) for this long is closed 1001. Default 150_000. */
  idleTimeoutMs?: number;
  /** Broadcast messages kept for resume (persisted in DO storage); 0 disables resume replay. Default 50. */
  history?: number;
  /** Incoming frame cap in bytes; larger frames get `$error` and are dropped. Default 65_536. */
  maxMessageBytes?: number;
  /** Announce joins/leaves as `$presence` messages. Default true. */
  presence?: boolean;
}
const DEFAULTS: Required<RoomOptions> = { heartbeatMs: 60_000, idleTimeoutMs: 150_000, history: 50, maxMessageBytes: 65_536, presence: true };

/** One entry of a migrations list: SQL text, or a function for data migrations. Version = index + 1. */
export type Migration = string | ((sql: SqlStorage) => void);

/** Typed tagged-template wrapper over `ctx.storage.sql`: parameters are bound, never interpolated. */
export type SqlTag = {
  <T = Record<string, SqlStorageValue>>(strings: TemplateStringsArray, ...values: SqlStorageValue[]): T[];
  /** First row or undefined. */
  one<T = Record<string, SqlStorageValue>>(strings: TemplateStringsArray, ...values: SqlStorageValue[]): T | undefined;
  raw: SqlStorage;
};

export function sqlTag(sql: SqlStorage): SqlTag {
  const q = (strings: TemplateStringsArray, ...values: SqlStorageValue[]) => sql.exec(strings.join("?"), ...values).toArray();
  return Object.assign(q, { one: (strings: TemplateStringsArray, ...values: SqlStorageValue[]) => q(strings, ...values)[0], raw: sql }) as SqlTag;
}

/** Apply `migrations[v..]` once each, in order, recording the version. Idempotent; a throwing migration leaves the version untouched. */
export function applyMigrations(storage: DurableObjectStorage, migrations: readonly Migration[]): number {
  const sql = storage.sql;
  sql.exec("CREATE TABLE IF NOT EXISTS cfl_migrations (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)");
  const row = sql.exec("SELECT version FROM cfl_migrations WHERE id = 1").toArray()[0] as { version: number } | undefined;
  let v = row ? Number(row.version) : 0;
  for (; v < migrations.length; v++) {
    const m = migrations[v];
    storage.transactionSync(() => {
      if (typeof m === "string") sql.exec(m);
      else m(sql);
      sql.exec("INSERT INTO cfl_migrations (id, version) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version", v + 1);
    });
  }
  return v;
}

/**
 * SQLite-backed Durable Object base: `static migrations` run once per version before the first request,
 * `this.sql\`select * from t where id = ${id}\`` is typed and parameterised.
 *
 *   export default class Counter extends SqlDO<Env> {
 *     static migrations = ["CREATE TABLE hits (n INTEGER)", "INSERT INTO hits VALUES (0)"];
 *     async fetch() { this.sql`UPDATE hits SET n = n + 1`; return Response.json(this.sql.one<{ n: number }>`SELECT n FROM hits`); }
 *   }
 */
export class SqlDO<E = unknown> extends DurableObject<E> {
  static migrations: readonly Migration[] = [];
  readonly sql: SqlTag;
  constructor(ctx: DurableObjectState, env: E) {
    super(ctx, env);
    this.sql = sqlTag(ctx.storage.sql);
    const migrations = (this.constructor as typeof SqlDO).migrations;
    if (migrations.length) ctx.blockConcurrencyWhile(async () => { applyMigrations(ctx.storage, migrations); });
  }
}

/** `class Counter extends defineDO<Env>({ migrations: [...] }) { ... }` - same as `SqlDO` with the migrations given inline. */
export function defineDO<E = unknown>(opts: { migrations?: readonly Migration[] } = {}): typeof SqlDO<E> {
  return class extends SqlDO<E> { static override migrations = opts.migrations ?? []; } as typeof SqlDO<E>;
}

/** A connected socket as handlers see it. */
export interface Conn<Meta = unknown> {
  readonly id: string;
  readonly ws: WebSocket;
  readonly tags: readonly string[];
  readonly meta: Meta;
  /** Send `{type, data}` to this socket only. */
  send(type: string, data?: unknown): void;
  close(code?: number, reason?: string): void;
}

interface Attachment<Meta> { id: string; meta: Meta; tags: string[]; joinedAt: number; seen: number }
interface HistoryEntry { seq: number; env: Envelope; tag?: string; except?: string }

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const timingSafeEq = (a: string, b: string) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };

/** What `authorize()` may return: the identity of the connection, or a Response that refuses the upgrade. */
export type Admission<Meta> = Response | { meta?: Meta; tags?: string[]; id?: string };

/** Message handlers by `type`: `messages = { chat: (conn, data) => this.broadcast("chat", data) }`. */
export type MessageHandlers<Meta, Msgs> = { [K in keyof Msgs & string]?: (conn: Conn<Meta>, data: Msgs[K]) => void | Promise<void> };

/**
 * Hibernating WebSocket room. Extend it, export it from the Worker entry (`server/do/*.ts` does that for you), bind it in wrangler.
 *
 *   export default class Chat extends HibernatingRoom<Env, { name: string }, { say: { text: string } }> {
 *     authorize(req) { return { meta: { name: new URL(req.url).searchParams.get("name") ?? "anon" } }; }
 *     messages = { say: (conn, d) => this.broadcast("say", { from: conn.meta.name, text: d.text }) };
 *   }
 *
 * Nothing important lives in instance fields: after an eviction the class is reconstructed and sockets keep working because their
 * state is in the attachment (<= 2 KiB: keep `meta` small) and the stream position is in storage.
 */
export class HibernatingRoom<E = unknown, Meta = unknown, Msgs extends Record<string, unknown> = Record<string, unknown>> extends DurableObject<E> {
  static options: RoomOptions = {};
  static migrations: readonly Migration[] = [];
  readonly sql: SqlTag;
  messages: MessageHandlers<Meta, Msgs> = {};

  #opts: Required<RoomOptions>;
  #seq = 0;
  #history: HistoryEntry[] = [];
  #key: CryptoKey | undefined;
  #ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: E) {
    super(ctx, env);
    const C = this.constructor as typeof HibernatingRoom;
    this.#opts = { ...DEFAULTS, ...C.options };
    this.sql = sqlTag(ctx.storage.sql);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.#ready = ctx.blockConcurrencyWhile(async () => {
      if (C.migrations.length) applyMigrations(ctx.storage, C.migrations);
      const got = await ctx.storage.get<{ seq: number; history: HistoryEntry[] }>("$rt:stream");
      if (got) { this.#seq = got.seq; this.#history = got.history; }
    });
  }

  // ---- extension points ------------------------------------------------------------------------------------------------

  /** Decide who may connect. Default: everyone, no meta. Return a Response (401/403) to refuse. `tags` = channels to join. */
  authorize(_req: Request): Admission<Meta> | Promise<Admission<Meta>> { return {}; }
  /** A socket was admitted (after `$hello`). */
  onConnect(_conn: Conn<Meta>, _req: Request): void | Promise<void> {}
  /** A frame with no entry in `messages` (or a non-JSON frame: `type` is "$raw", data the string). */
  onMessage(_conn: Conn<Meta>, _msg: Envelope): void | Promise<void> {}
  onClose(_conn: Conn<Meta>, _code: number, _reason: string): void | Promise<void> {}
  /** Your own alarm work: called from `alarm()` after the idle sweep. Return a timestamp to be woken again then. */
  onAlarm(): number | void | Promise<number | void> {}

  // ---- API ---------------------------------------------------------------------------------------------------------------

  /** Live connections (optionally only those in channel `tag`). */
  connections(tag?: string): Conn<Meta>[] {
    return this.ctx.getWebSockets(tag).flatMap((ws) => { const c = this.#conn(ws); return c ? [c] : []; });
  }
  presence(tag?: string): Presence<Meta>[] {
    return this.connections(tag).map((c) => { const a = c.ws.deserializeAttachment() as Attachment<Meta>; return { id: a.id, meta: a.meta, tags: a.tags, joinedAt: a.joinedAt }; });
  }
  /**
   * Send to every socket (or channel `tag`), stamped with the next sequence number and kept in the resume history.
   * Returns the sequence number. `except` = a connection id to skip (e.g. the sender).
   */
  async broadcast(type: string, data?: unknown, o: { tag?: string; except?: string; from?: string } = {}): Promise<number> {
    await this.#ready;
    const env: Envelope = { type, data, seq: ++this.#seq, ...(o.from ? { from: o.from } : {}) };
    if (this.#opts.history > 0) {
      this.#history.push({ seq: env.seq!, env, tag: o.tag, except: o.except });
      if (this.#history.length > this.#opts.history) this.#history.splice(0, this.#history.length - this.#opts.history);
    }
    await this.ctx.storage.put("$rt:stream", { seq: this.#seq, history: this.#history });
    const text = JSON.stringify(env);
    for (const ws of this.ctx.getWebSockets(o.tag)) {
      const a = ws.deserializeAttachment() as Attachment<Meta> | null;
      if (a && a.id !== o.except) try { ws.send(text); } catch { /* closing socket */ }
    }
    return env.seq!;
  }
  /** Update a connection's presence meta (and tell the room). */
  setMeta(conn: Conn<Meta>, meta: Meta): void {
    const a = conn.ws.deserializeAttachment() as Attachment<Meta>;
    conn.ws.serializeAttachment({ ...a, meta });
    this.#announce("update", { ...a, meta });
  }

  // ---- runtime entry points ----------------------------------------------------------------------------------------------

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket upgrade", { status: 426, headers: { Upgrade: "websocket" } });
    await this.#ready;
    const adm = await this.authorize(req);
    if (adm instanceof Response) return adm;
    const url = new URL(req.url);
    const tags = [...new Set([...(adm.tags ?? []), ...url.searchParams.getAll("tag").filter(() => adm.tags === undefined)])].slice(0, 9);
    let id = adm.id ?? crypto.randomUUID();
    let resumed = false;
    let since = 0;
    const token = url.searchParams.get("resume");
    if (token) {
      const rid = await this.#verify(token);
      if (rid) { id = rid; resumed = true; since = Number(url.searchParams.get("since")) || 0; }
    }
    const pair = new WebSocketPair();
    const att: Attachment<Meta> = { id, meta: adm.meta as Meta, tags, joinedAt: Date.now(), seen: Date.now() };
    // Drop a stale socket of the same identity (the client reconnected before we noticed the old one died).
    let hadOld = false;
    for (const ws of this.ctx.getWebSockets()) { const a = ws.deserializeAttachment() as Attachment<Meta> | null; if (a?.id === id) { hadOld = true; try { ws.serializeAttachment({ ...a, id: a.id + "#gone" }); ws.close(1000, "replaced"); } catch {} } }
    this.ctx.acceptWebSocket(pair[1], tags);
    pair[1].serializeAttachment(att);
    const conn = this.#conn(pair[1])!;
    const replay = resumed ? this.#history.filter((h) => h.seq > since && h.except !== id && (!h.tag || tags.includes(h.tag))) : [];
    const gap = resumed && this.#history.length > 0 && since < this.#history[0].seq - 1;
    conn.send("$hello", { id, token: await this.#sign(id), seq: this.#seq, presence: this.presence(), resumed, gap: gap || (resumed && this.#opts.history === 0 && since < this.#seq) });
    for (const h of replay) pair[1].send(JSON.stringify(h.env));
    if (!resumed || !hadOld) this.#announce("join", att, pair[1]);
    await this.#schedule();
    await this.onConnect(conn, req);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const conn = this.#conn(ws);
    if (!conn) return;
    ws.serializeAttachment({ ...(ws.deserializeAttachment() as Attachment<Meta>), seen: Date.now() });
    const size = typeof raw === "string" ? enc.encode(raw).byteLength : raw.byteLength;
    if (size > this.#opts.maxMessageBytes) return conn.send("$error", { message: "message too large" });
    let msg: Envelope;
    try {
      const parsed = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
      if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") throw new Error("not an envelope");
      msg = parsed;
    } catch { msg = { type: "$raw", data: typeof raw === "string" ? raw : raw.byteLength }; }
    const h = (this.messages as Record<string, ((c: Conn<Meta>, d: unknown) => void | Promise<void>) | undefined>)[msg.type];
    try {
      if (h && !msg.type.startsWith("$")) await h(conn, msg.data);
      else await this.onMessage(conn, msg);
    } catch (e) {
      console.error("cf-lite realtime: handler failed", e);
      conn.send("$error", { message: "internal error" });
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean?: boolean): Promise<void> {
    const conn = this.#conn(ws);
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, reason); } catch { /* already closed */ }
    if (!conn) return;
    const a = ws.deserializeAttachment() as Attachment<Meta>;
    if (!a.id.endsWith("#gone")) this.#announce("leave", a, ws);
    await this.onClose(conn, code, reason);
  }
  webSocketError(ws: WebSocket, _error: unknown): void { try { ws.close(1011, "error"); } catch { /* */ } }

  async alarm(): Promise<void> {
    const now = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment<Meta> | null;
      const last = Math.max(a?.seen ?? 0, this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0);
      if (now - last > this.#opts.idleTimeoutMs) { try { ws.close(1001, "idle"); } catch { /* */ } await this.webSocketClose(ws, 1001, "idle"); }
    }
    const own = await this.onAlarm();
    await this.#schedule(typeof own === "number" ? own : undefined);
  }

  // ---- internals -----------------------------------------------------------------------------------------------------------

  #conn(ws: WebSocket): Conn<Meta> | null {
    const a = ws.deserializeAttachment() as Attachment<Meta> | null;
    if (!a) return null;
    return {
      id: a.id, ws, tags: a.tags, meta: a.meta,
      send: (type, data) => { try { ws.send(JSON.stringify({ type, data })); } catch { /* closing */ } },
      close: (code, reason) => { try { ws.close(code, reason); } catch { /* */ } },
    };
  }
  #announce(op: "join" | "leave" | "update", a: Attachment<Meta>, skip?: WebSocket): void {
    if (!this.#opts.presence) return;
    const text = JSON.stringify({ type: "$presence", data: { op, id: a.id, meta: a.meta } });
    for (const ws of this.ctx.getWebSockets()) if (ws !== skip) try { ws.send(text); } catch { /* */ }
  }
  async #schedule(at?: number): Promise<void> {
    const hb = this.#opts.heartbeatMs;
    const next = hb > 0 && this.ctx.getWebSockets().length ? Date.now() + hb : undefined;
    const when = next !== undefined && at !== undefined ? Math.min(next, at) : (next ?? at);
    if (when === undefined) return;
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || when < cur) await this.ctx.storage.setAlarm(when);
  }
  async #hmac(): Promise<CryptoKey> {
    if (this.#key) return this.#key;
    let raw = await this.ctx.storage.get<Uint8Array<ArrayBuffer>>("$rt:key");
    if (!raw) { raw = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(32))); await this.ctx.storage.put("$rt:key", raw); }
    return (this.#key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]));
  }
  async #sign(id: string): Promise<string> { return `${id}.${hex(await crypto.subtle.sign("HMAC", await this.#hmac(), enc.encode(id)))}`; }
  async #verify(token: string): Promise<string | null> {
    const i = token.lastIndexOf(".");
    if (i < 1) return null;
    const id = token.slice(0, i);
    return timingSafeEq(await this.#sign(id), token) ? id : null;
  }
}

/** Typed access to a namespace binding: `const rooms = doStub(() => env.CHAT); await rooms.fetch("lobby", req)` (forwards an upgrade). */
export function doStub<S extends Rpc.DurableObjectBranded | undefined = undefined>(ns: () => DurableObjectNamespace<S>) {
  return {
    get: (name: string): DurableObjectStub<S> => { const n = ns(); return n.get(n.idFromName(name)); },
    fetch: (name: string, req: Request): Promise<Response> => { const n = ns(); return n.get(n.idFromName(name)).fetch(req); },
  };
}
