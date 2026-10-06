# Headless CMS head (example `examples/cms-head`)

A worked integration of [draft mode](draft-mode.md), [CMS webhooks](webhooks.md) and [ISR](isr.md): a public site rendered from a headless CMS, with live preview inside the CMS editor.

* Route-by-URL from the CMS through one optional catch-all (`app/routes/[[...path]].tsx`), `notFound()` for unknown routes, en/vi locales.
* A content-type -> component registry of plain sync components (React adapter) and block composition; data is fetched once in the loader.
* `isDraft(c)` selects the CMS draft version; `isr()` bypasses on the preview cookie. Publish -> signed webhook -> queue -> tag purge -> ISR regeneration (`trackContent` / `contentTags`).
* A mock CMS (GraphQL subset, published vs draft, signed webhooks, editor UI) so everything runs offline in workerd; a generic `cms:content-saved` listener makes the framed page refresh on save.

Read `examples/cms-head/README.md` for the file map, the design notes and **how to adapt it to a real CMS such as Optimizely Graph**. Tests: `examples/cms-head/test` (unit), `scripts/cms-head-e2e.mjs` (workerd, two colos), `e2e/cms-head.spec.ts` (browser).
