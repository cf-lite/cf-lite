# Realtime: Durable Objects, hibernating WebSockets

> **Experimental tier** (`cf-lite/modules/realtime`, `cf-lite/client-realtime`): no semver guarantee until a production app uses it (roadmap 1.0, WP-REALTIME).

Cloudflare-native: a room **is** a Durable Object, the socket **is** the Hibernation API. cf-lite adds a base class, a client, a file convention and a CLI command; there is no runtime layer in between.

## Quick start

```bash
bunx cf-lite add do chat      # server/do/chat.ts + wrangler durable_objects binding CHAT + SQLite migration
```

```ts
// server/do/chat.ts
import { HibernatingRoom } from "cf-lite/modules/realtime";

export default class Chat extends HibernatingRoom<Env, { name: string }, { chat: { text: string } }> {
  authorize(req: Request) {                       // who may connect; return a Response to refuse
    const name = new URL(req.url).searchParams.get("name");
    return name ? { meta: { name } } : new Response("name required", { status: 400 });
  }
  messages = {                                    // typed handlers by message type
    chat: (conn, d) => this.broadcast("chat", { name: conn.meta.name, text: d.text }, { from: conn.id }),
  };
}
```

```ts
// server/worker.ts
import app from "../.cf-lite/app";
export * from "../.cf-lite/do-classes";           // DO classes must be exported from the Worker entry
export default { fetch: app.fetch } satisfies ExportedHandler<Env>;

// server/api/rooms.ts
import { durableObjects } from "../../.cf-lite/do";
export default new Hono<{ Bindings: Env }>().get("/:room", (c) => durableObjects.chat.fetch(c.req.param("room"), c.req.raw));
```

```ts
// browser (framework-free)
import { connectChannel } from "cf-lite/client-realtime";
const ch = connectChannel("/api/rooms/lobby", { params: { name: "ada" } });
ch.on("chat", (m) => render(m));  ch.on("$presence", (p) => ...);  ch.send("chat", { text: "hi" });
```

The full app is the `realtime` template (`packages/cf-lite/templates/realtime`, used by `scripts/realtime-e2e.mjs`).

## `server/do/*.ts` convention

| Export | Meaning |
|---|---|
| `default` | the class (`HibernatingRoom`, `SqlDO`, any `DurableObject`) |
| `className` | optional; default PascalCase of the file name; must equal wrangler `class_name` |
| `binding` | optional; default UPPER_SNAKE of the file name (`match-room` -> `MATCH_ROOM`) |

Generated (`.cf-lite/`, zero bytes when `server/do/` does not exist): `do-classes.ts` (re-exports for the Worker entry) and `do.ts` (`durableObjects.<file>.get(name)` / `.fetch(name, request)`, name → `idFromName`).
Doctor checks at dev/build start: missing binding, wrong `class_name`, no migration creating the class, class only in legacy `new_classes` (KV-backed).

`cf-lite add do <name>` never overwrites, edits `wrangler.jsonc` at text level (comments kept), appends a migration `vN+1` with `new_sqlite_classes`; when the config can't be edited safely it prints the snippet. **Deleting/renaming a class needs a hand-written `deleted_classes`/`renamed_classes` migration** - cf-lite never writes destructive migrations.

## `HibernatingRoom`

- **Hibernation**: sockets are accepted with `ctx.acceptWebSocket`; between messages the DO is evicted and you are billed nothing for idle connections. All per-socket state is in the **attachment** (id, meta, tags; ≤ 2 KiB — keep `meta` small), the stream position in storage. Do not keep state in instance fields; after eviction the class is reconstructed. (`scripts/realtime-e2e.mjs` proves this under real workerd: idle > 10 s → a new instance, same sockets, same SQLite rows.)
- **Channels** = hibernation tags. `authorize()` returns `{ meta, tags, id }`; if it returns no `tags`, the client's `?tag=` params are used. Use `broadcast(type, data, { tag, except })` and `connections(tag)`.
- **Presence**: `presence()` is derived from live sockets; `$hello.presence` snapshot on connect, `$presence {op: join|leave|update}` afterwards (`setMeta(conn, meta)` to update). Disable with `static options = { presence: false }`.
- **Typed protocol**: `Envelope = { type, data?, seq?, from? }` JSON frames. Types starting with `$` are reserved for the server (`$hello`, `$presence`, `$error`); a client-sent `$…` type never reaches `messages`. Non-JSON frames go to `onMessage` as `$raw`; frames > `maxMessageBytes` get `$error`; a throwing handler gets `$error` and the room keeps running.
- **Resume**: every `broadcast()` gets a sequence number and is kept in a bounded history (`history`, default 50, persisted). `$hello.token` is `id.HMAC(id)` (per-room secret in storage, unforgeable); the client reconnects with `?resume=<token>&since=<seq>` and gets the same identity, no duplicate join, and the missed messages (tag/except filtered). `$hello.gap: true` = history no longer covers `since` → refetch state. A still-registered old socket of the same identity is closed (`replaced`) without a leave announcement.
- **Alarms / heartbeat**: while sockets exist an alarm every `heartbeatMs` (default 60 s) closes sockets silent for `idleTimeoutMs` (default 150 s; `ping` auto-responses count, without waking the DO). **The alarm wakes the DO each period** — set `heartbeatMs: 0` for maximum hibernation and rely on client close events. Your own alarm work: `onAlarm()` returns the next timestamp (or nothing).
- **Options**: `static options = { heartbeatMs, idleTimeoutMs, history, maxMessageBytes, presence }`. Extension points: `authorize`, `onConnect`, `onMessage`, `onClose`, `onAlarm`, `messages`.
- **Security**: `authorize()` is the only gate — the DO is reachable only through your Worker route, so put auth (`cf-lite/modules/session`) in the route or in `authorize`. Check `Origin` there for browser clients (WebSocket upgrades are not covered by CORS/CSRF).

## SQLite data layer: `SqlDO` / `defineDO`

```ts
export default class Counter extends SqlDO<Env> {
  static migrations = ["CREATE TABLE hits (n INTEGER)", "INSERT INTO hits VALUES (0)", (sql) => { /* data migration */ }];
  async fetch() { this.sql`UPDATE hits SET n = n + 1`; return Response.json(this.sql.one<{ n: number }>`SELECT n FROM hits`); }
}
// or: class Counter extends defineDO<Env>({ migrations: [...] }) {}
```

`this.sql` is a tagged template: `${values}` are **bound parameters**, never interpolated. Migrations are versioned by index (1-based), each runs once in a transaction before the first request; a failing one is not recorded and is retried. `HibernatingRoom` supports the same `static migrations` and `this.sql`. Table names starting with `_cf_` are reserved by Cloudflare — cf-lite uses `cfl_migrations`.

## `connectChannel(url, opts)`

`{ status, id, lastSeq, send, on(type|"*"), onStatus, close }`. Options: `params`, `backoff {base 500, max 15000, factor 2, jitter 0.5}`, `maxRetries` (default ∞), `pingMs` (25 s; 0 off) + `pongTimeoutMs` (10 s), `queueLimit` (100 offline messages, oldest dropped), `WebSocket` (override for tests/Node < 22). The attempt counter resets on `$hello`, not on raw open, so a room that refuses after upgrade keeps backing off. Statuses: `connecting | open | reconnecting | closed`.

## Limits and left for later

- Cloudflare: ≤ 32 768 hibernating sockets per DO (soft guidance: a few thousand), attachment 2 KiB, 128 MB memory, single-threaded per room — shard by room name.
- Not included (experimental tier): multi-room pub/sub fan-out via a hub DO, server-side per-connection rate limiting, binary protocol helpers, framework hooks (`useChannel`) — the client is deliberately framework-free.
- Local dev: `cf-lite dev` runs DOs in workerd; hibernation happens after ~10 s idle there too.
