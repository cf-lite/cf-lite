interface Env {
  ASSETS: Fetcher;
  STATE: KVNamespace;
  JOBS_QUEUE: Queue;
  JOBS_DLQ_QUEUE: Queue;
  ONBOARDING_WORKFLOW: Workflow;
}
