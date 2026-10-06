/**
 * OPTIONAL module: typed, validated `env`. `defineEnv({ SECRET: z.string() })` validates the Worker bindings once
 * per isolate and fails *closed*: a missing/invalid variable throws an error that names every offender (never a value),
 * so a half-configured deploy returns 500s instead of running with `undefined` secrets.
 *
 * A field is any Standard Schema validator (zod >= 3.24, valibot, arktype) or a plain `(value) => parsed` function that
 * throws on bad input. No dependency on any of them.
 */
type Issue = { message: string };
type Standard<T> = { "~standard": { validate(v: unknown): { value: T; issues?: undefined } | { issues: readonly Issue[] } | Promise<any> } };
export type EnvField<T = unknown> = Standard<T> | ((value: unknown) => T);
export type EnvShape = Record<string, EnvField>;
export type InferEnv<S extends EnvShape> = { [K in keyof S]: S[K] extends Standard<infer T> ? T : S[K] extends (v: unknown) => infer T ? T : never };

export class EnvError extends Error {
  constructor(public readonly problems: { name: string; message: string }[]) {
    super(`invalid environment - fix these bindings/secrets (values are never printed):\n${problems.map((p) => `  - ${p.name}: ${p.message}`).join("\n")}`);
    this.name = "EnvError";
  }
}

function check(field: EnvField, value: unknown): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    if (typeof field === "function") return { ok: true, value: field(value) };
    const r = field["~standard"].validate(value);
    if (r instanceof Promise) return { ok: false, message: "async validators are not supported in defineEnv" };
    if (r.issues) return { ok: false, message: r.issues.map((i: Issue) => i.message).join("; ") };
    return { ok: true, value: r.value };
  } catch (e) { return { ok: false, message: e instanceof Error ? e.message : "invalid" }; }
}

/** Pure validation: returns the parsed env or throws `EnvError`. Extra bindings (D1, KV, ...) pass through untouched. */
export function parseEnv<S extends EnvShape>(shape: S, raw: Record<string, unknown>): InferEnv<S> & Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  const problems: { name: string; message: string }[] = [];
  for (const [name, field] of Object.entries(shape)) {
    const r = check(field, raw[name]);
    if (r.ok) out[name] = r.value; else problems.push({ name, message: raw[name] === undefined ? `missing (${r.message})` : r.message });
  }
  if (problems.length) throw new EnvError(problems);
  return out as any;
}

/**
 * `const envOf = defineEnv({ API_KEY: z.string().min(10) })` then `envOf(c.env)` in a handler/middleware.
 * The result is cached per raw env object, so validation runs once per isolate, not per request.
 */
export function defineEnv<S extends EnvShape>(shape: S) {
  const cache = new WeakMap<object, InferEnv<S> & Record<string, unknown>>();
  return (raw: object): InferEnv<S> & Record<string, unknown> => {
    let hit = cache.get(raw);
    if (!hit) { hit = parseEnv(shape, raw as Record<string, unknown>); cache.set(raw, hit); }
    return hit;
  };
}

/** Hono middleware form: validates on first request, answers 500 (no detail) when invalid, logs the offenders' names. */
export function envGuard<S extends EnvShape>(shape: S) {
  const get = defineEnv(shape);
  return async (c: { env: object; text(body: string, status?: number): Response }, next: () => Promise<void>): Promise<Response | void> => {
    try { get(c.env); } catch (e) {
      console.error(e instanceof Error ? e.message : "invalid environment");
      return c.text("Server misconfigured", 500);
    }
    await next();
  };
}
