/** Workflows helpers (docs/background-jobs.md): the typed producer behind the generated `workflows.<name>`. */

/** `Params` of a `WorkflowEntrypoint<Env, Params>` class, read from its `run(event)` signature. */
export type WorkflowParams<C> = C extends abstract new (...a: any[]) => { run(event: Readonly<{ payload: Readonly<infer P> }>, ...rest: any[]): unknown } ? P : unknown;

export interface WorkflowProducer<P> {
  /** Start an instance. `id` makes it idempotent-ish: creating an existing id fails (Cloudflare), so use stable ids for dedupe. */
  create(opts?: { id?: string; params?: P }): Promise<WorkflowInstance>;
  createBatch(batch: { id?: string; params?: P }[]): Promise<WorkflowInstance[]>;
  get(id: string): Promise<WorkflowInstance>;
  /** `status()` of instance `id`. */
  status(id: string): Promise<InstanceStatus>;
}

export function workflowProducer<P = unknown>(get: () => Workflow | undefined): WorkflowProducer<P> {
  const w = () => {
    const v = get();
    if (!v) throw new Error("[cf-lite] workflow binding is missing - add it to wrangler `workflows` (cf-lite add workflow <name>)");
    return v;
  };
  return {
    create: (o) => w().create(o as never),
    createBatch: (b) => w().createBatch(b as never),
    get: (id) => w().get(id),
    status: async (id) => (await w().get(id)).status(),
  };
}
