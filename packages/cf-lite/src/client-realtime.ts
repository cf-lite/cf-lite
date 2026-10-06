/**
 * `cf-lite/client-realtime` - framework-free WebSocket channel client for `HibernatingRoom` (docs/realtime.md).
 *
 *   const ch = connectChannel("/api/rooms/lobby", { params: { name: "ada" } });
 *   ch.on("chat", (data) => ...);  ch.on("$presence", ...);  ch.send("chat", { text: "hi" });
 *   ch.onStatus((s) => ...);       // "connecting" | "open" | "reconnecting" | "closed"
 *   ch.close();
 *
 * Reconnects with exponential backoff + jitter; resumes the stream (`resume` token + last `seq` -> the room replays what was missed;
 * `$hello.gap` tells you when history no longer covers it); sends `ping` every `pingMs` and reconnects when no frame arrives within
 * `pongTimeoutMs`; messages sent while offline are queued (bounded) and flushed on open. No dependencies, no DOM beyond `WebSocket`.
 */

export type ChannelStatus = "connecting" | "open" | "reconnecting" | "closed";
export interface Envelope<T = unknown> { type: string; data?: T; seq?: number; from?: string }

export interface BackoffOptions { base?: number; max?: number; factor?: number; /** 0..1 fraction of the delay randomised (default 0.5). */ jitter?: number }
export interface ChannelOptions {
  /** Query params added to the URL (e.g. `{ name: "ada", tag: "room:1" }`; arrays repeat the key). */
  params?: Record<string, string | string[]>;
  protocols?: string | string[];
  backoff?: BackoffOptions;
  /** Give up after this many consecutive failed attempts (default: never). */
  maxRetries?: number;
  /** `ping` period; 0 disables. Default 25_000. */
  pingMs?: number;
  /** Reconnect when nothing (incl. `pong`) arrived for this long after a ping. Default 10_000. */
  pongTimeoutMs?: number;
  /** Max messages held while offline (oldest dropped). Default 100. */
  queueLimit?: number;
  /** Override for tests / non-browser runtimes. */
  WebSocket?: typeof WebSocket;
  random?: () => number;
}

export interface Channel {
  readonly status: ChannelStatus;
  /** Server-assigned connection id (after `$hello`). */
  readonly id: string | undefined;
  /** Last `seq` seen on the resumable stream. */
  readonly lastSeq: number;
  send(type: string, data?: unknown): void;
  /** Subscribe to a message type (`"*"` = every message, incl. control ones). Returns an unsubscribe function. */
  on<T = unknown>(type: string, fn: (data: T, env: Envelope<T>) => void): () => void;
  onStatus(fn: (s: ChannelStatus) => void): () => void;
  close(code?: number, reason?: string): void;
}

/** Delay before attempt `n` (0-based): min(max, base * factor^n), randomised downwards by `jitter`. Exported for tests. */
export function backoffDelay(n: number, o: BackoffOptions = {}, random: () => number = Math.random): number {
  const { base = 500, max = 15_000, factor = 2, jitter = 0.5 } = o;
  const d = Math.min(max, base * factor ** n);
  return Math.round(d * (1 - jitter * random()));
}

export function connectChannel(url: string, opts: ChannelOptions = {}): Channel {
  const WS = opts.WebSocket ?? globalThis.WebSocket;
  const rnd = opts.random ?? Math.random;
  const pingMs = opts.pingMs ?? 25_000;
  const pongTimeoutMs = opts.pongTimeoutMs ?? 10_000;
  const queueLimit = opts.queueLimit ?? 100;
  const listeners = new Map<string, Set<(d: any, e: any) => void>>();
  const statusFns = new Set<(s: ChannelStatus) => void>();
  let status: ChannelStatus = "connecting";
  let ws: WebSocket | undefined;
  let token: string | undefined;
  let id: string | undefined;
  let lastSeq = 0;
  let attempt = 0;
  let closedByUser = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let deadTimer: ReturnType<typeof setTimeout> | undefined;
  const queue: string[] = [];

  const setStatus = (s: ChannelStatus) => { if (s === status) return; status = s; for (const f of [...statusFns]) f(s); };
  const emit = (type: string, env: Envelope) => {
    for (const k of [type, "*"]) for (const f of [...(listeners.get(k) ?? [])]) { try { f(env.data, env); } catch (e) { console.error("connectChannel listener", e); } }
  };
  const target = () => {
    const u = new URL(url, globalThis.location?.href ?? "http://localhost");
    u.protocol = u.protocol === "https:" ? "wss:" : u.protocol === "http:" ? "ws:" : u.protocol;
    for (const [k, v] of Object.entries(opts.params ?? {})) for (const x of Array.isArray(v) ? v : [v]) u.searchParams.append(k, x);
    if (token) { u.searchParams.set("resume", token); u.searchParams.set("since", String(lastSeq)); }
    return u.toString();
  };
  const stopTimers = () => { clearInterval(pingTimer); clearTimeout(deadTimer); pingTimer = deadTimer = undefined; };

  const schedule = () => {
    if (closedByUser) return;
    if (opts.maxRetries !== undefined && attempt >= opts.maxRetries) { setStatus("closed"); return; }
    setStatus("reconnecting");
    retryTimer = setTimeout(open, backoffDelay(attempt++, opts.backoff, rnd));
  };
  const armDead = () => { clearTimeout(deadTimer); deadTimer = setTimeout(() => { try { ws?.close(4000, "no pong"); } catch {} lost(ws!); }, pongTimeoutMs); };
  const lost = (sock: WebSocket) => { if (sock !== ws) return; ws = undefined; stopTimers(); schedule(); };

  function open() {
    if (closedByUser) return;
    let sock: WebSocket;
    try { sock = ws = new WS(target(), opts.protocols); } catch { schedule(); return; }
    sock.onopen = () => {
      if (sock !== ws) return;
      setStatus("open");
      // `attempt` resets when a $hello arrives (a real admitted connection), not on the raw open: a room that refuses the
      // socket right after upgrade must keep backing off.
      while (queue.length) sock.send(queue.shift()!);
      if (pingMs > 0) pingTimer = setInterval(() => { try { sock.send("ping"); armDead(); } catch {} }, pingMs);
    };
    sock.onmessage = (ev: MessageEvent) => {
      if (sock !== ws) return;
      clearTimeout(deadTimer);
      if (ev.data === "pong") return;
      let env: Envelope;
      try { env = JSON.parse(String(ev.data)); if (typeof env?.type !== "string") return; } catch { return; }
      if (env.type === "$hello") {
        const h = env.data as { id: string; token: string };
        id = h.id; token = h.token; attempt = 0;
      }
      if (typeof env.seq === "number" && env.seq > lastSeq) lastSeq = env.seq;
      emit(env.type, env);
    };
    sock.onclose = () => lost(sock);
    sock.onerror = () => { /* onclose follows */ };
  }
  open();

  return {
    get status() { return status; },
    get id() { return id; },
    get lastSeq() { return lastSeq; },
    send(type, data) {
      const text = JSON.stringify({ type, data });
      if (ws && status === "open" && ws.readyState === 1) ws.send(text);
      else if (!closedByUser) { queue.push(text); if (queue.length > queueLimit) queue.shift(); }
    },
    on(type, fn) {
      let set = listeners.get(type);
      if (!set) listeners.set(type, (set = new Set()));
      set.add(fn);
      return () => set!.delete(fn);
    },
    onStatus(fn) { statusFns.add(fn); return () => statusFns.delete(fn); },
    close(code = 1000, reason = "") {
      closedByUser = true;
      clearTimeout(retryTimer);
      stopTimers();
      const s = ws; ws = undefined;
      try { s?.close(code, reason); } catch {}
      setStatus("closed");
    },
  };
}
