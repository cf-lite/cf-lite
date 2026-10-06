# cf-lite documentation

Start with [getting-started.md](getting-started.md). Coming from Next.js: [migration-from-nextjs.md](migration-from-nextjs.md).  Honest gap list vs Next.js: [next-parity.md](next-parity.md). Task-oriented answers: [recipes.md](recipes.md). Something broke: [troubleshooting.md](troubleshooting.md). Agents/LLMs: [../AGENTS.md](../AGENTS.md), [../agents/README.md](../agents/README.md) (maintaining this repo), [../llms.txt](../llms.txt).

## Concepts

[design.md](design.md) (request flow, render modes) - [conventions.md](conventions.md) (files to generated code) - [routing.md](routing.md) - [view-transitions.md](view-transitions.md) - [adapters.md](adapters.md) - [middleware.md](middleware.md) - [route-config.md](route-config.md)

## Capabilities

| Area | Pages |
|---|---|
| Data and mutations | [actions.md](actions.md), [storage.md](storage.md), [caching.md](caching.md), [isr.md](isr.md), [webhooks.md](webhooks.md), [draft-mode.md](draft-mode.md), [typegen.md](typegen.md) |
| Background and realtime | [background-jobs.md](background-jobs.md), [realtime.md](realtime.md) |
| Identity and safety | [auth.md](auth.md), [security.md](security.md), [threat-model.md](threat-model.md), [security-review.md](security-review.md) |
| Content and assets | [metadata.md](metadata.md), [assets.md](assets.md), [images.md](images.md), [i18n.md](i18n.md) |
| AI | [ai.md](ai.md) |
| Operations | [deploy.md](deploy.md), [observability.md](observability.md), [testing.md](testing.md) |
| Tooling | [dx.md](dx.md), [doctor.md](doctor.md), [troubleshooting.md](troubleshooting.md), [preview.md](preview.md) (`/__preview`), [mocks.md](mocks.md) (`MOCK=1`), [export.md](export.md) (`cfl export`), [generators.md](generators.md) (`cfl g`, `cfl seed`), [llm.md](llm.md) (`cfl mcp`, `cfl ask`), [llm-gateway-test.md](llm-gateway-test.md), [llm-terms.md](llm-terms.md), [coming-from-mvc.md](coming-from-mvc.md) |
| Experimental | [rsc.md](rsc.md) (React Server Components, opt-in), [islands.md](islands.md) (SSR islands, partial hydration) |

## Project

[roadmap-1.0.md](roadmap-1.0.md) - [roadmap-dx.md](roadmap-dx.md) - [bun-first.md](bun-first.md) - [stability.md](stability.md) - [published.md](published.md) - [DECISIONS.md](DECISIONS.md) (what was decided, by which role) - [upgrading.md](upgrading.md) - [a11y.md](a11y.md) - [performance-budgets.md](performance-budgets.md) - [field-notes.md](field-notes.md) - [../CHANGELOG.md](../CHANGELOG.md)

Every capability page states its status (stable or experimental), what runs where (build, Worker, browser), what it costs on Cloudflare, and what needs an account or plan.
