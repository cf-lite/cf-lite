# Toolkit terms for the LLM layer (`cfl ask`)

Version **2026-10-02** (the value `cfl ask` stores with your consent). **Draft: not legal advice and not yet reviewed by someone qualified** ([roadmap-dx.md](roadmap-dx.md) 5.5).

1. **What this covers.** Only `cfl ask` (and any future command that calls a language model). `cfl mcp`, `cfl g`, `cfl add` and every other command send nothing anywhere.
2. **What is sent.** The sentence you type (token-like strings replaced), the descriptions of the tools `cfl ask` may call, and the names (not contents) of project files, minus anything that looks like a secret or credential file. Details and the exact deny-list: [llm.md](llm.md).
3. **Who receives it.** The provider named in the notice. Today that is Cloudflare Workers AI on **your own** Cloudflare account, using the token you supply. Cloudflare's terms and data-use statement apply to that processing: <https://developers.cloudflare.com/workers-ai/platform/data-usage/>. We do not receive your request, and we run no service for it.
4. **Cost.** Usage is billed to your account under your plan. We give no estimate of calls per free allocation.
5. **No guarantee.** A model can misunderstand you. `cfl ask` only calls an allow-listed set of tools, shows a plan and a file diff, and writes nothing until you confirm; you are responsible for reviewing it. The toolkit is provided as-is under its license.
6. **No claim of privacy.** We make no statement about confidentiality, retention or training beyond what the provider's own terms state. Do not put secrets or personal data in the sentence.
7. **Consent.** Stored locally per user (`~/.config/cf-lite/consent.json`) with the provider and this version; a different provider or version asks again. Delete the file to withdraw. `cfl ask --terms` prints the notice.
