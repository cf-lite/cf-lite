// Runnable evaluation of `cfl ask` (docs/llm.md): bun scripts/nl-eval.ts [--set main|holdout|fresh|all] [--attempts 1|2] [--no-guard] [--no-ground] [--model @cf/...] [--category easy] [--limit N] [--offline] [--out file.json]
// Needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID (your own account; Workers AI usage is billed to it). --offline only validates the prompt set.
import { readFileSync, writeFileSync } from "node:fs";
import { BackendError, defaultModel, propose, type AskContext } from "../packages/cf-lite/src/ask.ts";
import { resolveRoute } from "../packages/cf-lite/src/ask-provider.ts";
import { checkSet, scoreCase, summarize, type CaseResult, type EvalCase } from "../packages/cf-lite/src/nl-eval.ts";

const argv = process.argv.slice(2);
const val = (k: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
// --set main (67, the gate set) | fresh (37, written once after the code was final, run once) | holdout (38, written before tuning, never used to tune prompts) | all
const setName = val("--set") ?? "main";
const load = (f: string): EvalCase[] => JSON.parse(readFileSync(new URL(`../packages/cf-lite/test/nl-eval/${f}`, import.meta.url), "utf8"));
const cases: EvalCase[] = setName === "holdout" ? load("prompts-holdout.json") : setName === "fresh" ? load("prompts-fresh.json") : setName === "all" ? [...load("prompts.json"), ...load("prompts-holdout.json"), ...load("prompts-fresh.json")] : load("prompts.json");
const errs = checkSet(cases, setName === "holdout" || setName === "fresh" ? 30 : 60);
if (errs.length) { console.error("prompt set invalid:\n  " + errs.join("\n  ")); process.exit(1); }
if (argv.includes("--offline")) { console.log(`prompt set ok: ${cases.length} cases`); process.exit(0); }

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "", token = process.env.CLOUDFLARE_API_TOKEN ?? "";
// --provider openai|anthropic [--base-url url | --gateway id]: your own key from the environment (ANTHROPIC_API_KEY / OPENAI_API_KEY), explicit opt-in as in `cfl ask`
const route = resolveRoute({ provider: val("--provider"), gateway: val("--gateway"), baseUrl: val("--base-url") }, process.env, accountId && token ? { accountId, token } : "no cloudflare credentials");
if (typeof route === "string") { console.error(route); process.exit(1); }
if (route.provider === "workers-ai" && (!accountId || !token)) { console.error("set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (export them first); nothing was sent"); process.exit(1); }
const model = val("--model") ?? defaultModel(route);
const ctx: AskContext = { ui: "react", files: ["package.json", "wrangler.jsonc", "vite.config.ts", "app/routes/index.tsx", "app/components/Card.tsx", "server/api/items.ts", "seeds/items.d1.json"] };
let todo = cases.filter((c) => !val("--category") || val("--category")!.split(",").includes(c.category));
if (val("--limit")) todo = todo.slice(0, Number(val("--limit")));

const results: CaseResult[] = [];
const queue = [...todo];
const worker = async () => {
  for (let c = queue.shift(); c; c = queue.shift()) {
    try {
      // default one attempt = raw tool-call validity; --attempts 2 = the real `cfl ask` flow (invalid call fed back once)
      const p = await propose(c.prompt, ctx, { creds: { accountId, token }, route, model, maxAttempts: Number(val("--attempts") ?? 1), guard: !argv.includes("--no-guard"), ground: !argv.includes("--no-ground") });
      const r = scoreCase(c, p); results.push(r);
      if (!r.pass) console.log(`FAIL ${r.id} "${c.prompt}": ${r.note}`);
    } catch (e) {
      if (e instanceof BackendError && e.kind === "quota") { console.error("quota reached: " + e.message); queue.length = 0; return; }
      results.push({ id: c.id, category: c.category, pass: false, calls: 0, validCalls: 0, dangerous: false, latencyMs: 0, tokens: 0, note: "backend: " + (e as Error).message });
      console.log(`ERR  ${c.id}: ${(e as Error).message}`);
    }
  }
};
await Promise.all(Array.from({ length: Number(val("--concurrency") ?? 3) }, worker));
const s = summarize(results);
const pct = (x: number) => (x * 100).toFixed(0) + "%";
console.log(`\nmodel ${route.provider === "workers-ai" ? "" : route.provider + " "}${model}: ${s.total} prompts, ${Object.entries(s.byCategory).map(([k, b]) => `${k} ${b.pass}/${b.n} (${pct(b.rate)})`).join(", ")}`);
console.log(`tool-call validity ${pct(s.validityRate)}, dangerous (valid call on hard/adversarial) ${s.dangerous}, median latency ${s.medianLatencyMs} ms, median tokens ${s.medianTokens}`);
console.log(`gate: easy+medium>=90% ${s.gate.easyMedium}, adversarial 100% ${s.gate.adversarial}, hard never applies ${s.gate.hardNeverApplies} => ${s.gate.pass ? "PASS" : "FAIL"}`);
if (val("--out")) writeFileSync(val("--out")!, JSON.stringify({ model, summary: s, results }, null, 2));
process.exit(s.gate.pass ? 0 : 2);
