/**
 * First-use notice and one-time consent for the model-backed commands (`cfl ask`, roadmap-dx 4.7 / 5.5, docs/llm.md).
 * Consent is stored per user (not per project) with the provider and the terms version; a change of either asks again.
 * No consent = no model call. `cfl mcp` and every plain command never need it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const TERMS_VERSION = "2026-10-02";
export const TOOLKIT_TERMS_URL = "https://github.com/cf-lite/cf-lite/blob/main/docs/llm-terms.md";
export const PROVIDERS = {
  "workers-ai": { label: "Cloudflare Workers AI (your own Cloudflare account)", termsUrl: "https://developers.cloudflare.com/workers-ai/platform/data-usage/", credential: "the account and API token you configured (CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN)" },
  openai: { label: "OpenAI (your own API key)", termsUrl: "https://openai.com/policies/privacy-policy/", credential: "your own key from OPENAI_API_KEY (or CFL_ASK_API_KEY)" },
  anthropic: { label: "Anthropic (your own API key)", termsUrl: "https://www.anthropic.com/legal/privacy", credential: "your own key from ANTHROPIC_API_KEY (or CFL_ASK_API_KEY)" },
} as const;
export type ProviderId = keyof typeof PROVIDERS;

export function noticeText(provider: ProviderId = "workers-ai", gateway = false): string[] {
  const p = PROVIDERS[provider];
  return [
    "cfl ask sends your request to a language model, so it is not offline. Before you use it:",
    "",
    "  What is sent:  your sentence (with token-like strings removed), the tool descriptions and the list of file",
    "                 names in the project (never .dev.vars*, .env*, keys or secrets; no file contents).",
    `  Sent to:       ${p.label}, using ${p.credential}${gateway ? "; routed through your Cloudflare AI Gateway (it can log and cache requests per its own settings)" : ""}.`,
    ...(provider === "workers-ai" ? [] : ["                 This provider was chosen by you (--provider / CFL_ASK_PROVIDER); cfl never switches provider by itself."]),
    `  Provider terms: ${p.termsUrl}`,
    `  Toolkit terms:  ${TOOLKIT_TERMS_URL} (version ${TERMS_VERSION})`,
    "",
    "  What it can do: only the allow-listed cfl tools. It never runs shell commands, never deploys, never touches the remote database,",
    "                  and shows a plan + file diff first; nothing is written until you confirm.",
    "  Not promised:   we make no claim about privacy beyond what the provider's terms say; the model can be wrong, review the plan.",
    "  Plain commands (cfl g, cfl add, cfl mcp ...) never send anything.",
  ];
}

export const consentFile = (): string => join(process.env.CFL_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "cf-lite"), "consent.json");

interface Stored { provider: string; termsVersion: string; acceptedAt: string }
export function hasConsent(provider: ProviderId = "workers-ai"): boolean {
  try {
    const j = JSON.parse(readFileSync(consentFile(), "utf8")) as { accepted?: Stored[] };
    return !!j.accepted?.some((c) => c.provider === provider && c.termsVersion === TERMS_VERSION);
  } catch { return false; }
}
export function recordConsent(provider: ProviderId = "workers-ai", now = new Date()): void {
  const f = consentFile();
  let accepted: Stored[] = [];
  try { if (existsSync(f)) accepted = (JSON.parse(readFileSync(f, "utf8")).accepted as Stored[]) ?? []; } catch { /* corrupt file: start over */ }
  accepted = accepted.filter((c) => c.provider !== provider);
  accepted.push({ provider, termsVersion: TERMS_VERSION, acceptedAt: now.toISOString() });
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify({ accepted }, null, 2) + "\n");
}

/** True when the user has consented (now or earlier). `accept` = `--accept-terms`; `confirm` asks y/N (absent = non-interactive: refuse). */
export async function ensureConsent(o: { provider?: ProviderId; gateway?: boolean; accept?: boolean; confirm?: (q: string) => Promise<boolean>; log: (m: string) => void }): Promise<boolean> {
  const provider = o.provider ?? "workers-ai";
  if (hasConsent(provider)) return true;
  noticeText(provider, o.gateway).forEach((l) => o.log(l));
  if (o.accept) { recordConsent(provider); o.log("\nConsent recorded (--accept-terms)."); return true; }
  if (!o.confirm) { o.log("\nNo consent recorded and no terminal to ask: re-run with --accept-terms, or use the plain commands (cfl g ...)."); return false; }
  if (!(await o.confirm("\nDo you accept and want to continue? [y/N] "))) { o.log("No consent: nothing was sent."); return false; }
  recordConsent(provider);
  return true;
}
