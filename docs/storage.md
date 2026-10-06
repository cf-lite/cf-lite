# Storage: D1, KV, R2, Hyperdrive

Thin, optional helpers over Cloudflare's storage bindings. Nothing here is loaded unless you import it
(`sideEffects: false`), and nothing needs an ORM. `examples/site-uploads` uses all of it.

| Need | Use | Consistency |
|---|---|---|
| Relational data, read-your-writes | D1 (`cf-lite/modules/d1`) | strong on primary; sequential via Sessions on replicas |
| Config, flags, cached renders, read-mostly | KV (`cf-lite/modules/kv`) | eventual, **~60 s** to propagate globally |
| Counters, locks, coordination | Durable Objects (not KV) | strong |
| Files / blobs | R2 (`cf-lite/modules/r2`) | strong |
| Existing Postgres/MySQL | Hyperdrive (`cf-lite/modules/hyperdrive`) | that database's |

## Add a binding

```bash
bunx cf-lite add d1          # -> d1_databases [{ binding: "DB", database_name: "<app>-db" }]
bunx cf-lite add kv          # -> kv_namespaces [{ binding: "KV" }]
bunx cf-lite add r2          # -> r2_buckets [{ binding: "BUCKET", bucket_name: "<app>-uploads" }]
bunx cf-lite add hyperdrive  # -> hyperdrive [{ binding: "HYPERDRIVE", id: "REPLACE_WITH_..." }]
# --binding MY_DB  --name resource-name   (binding must be UPPER_SNAKE_CASE)
```

The edit is idempotent and keeps your comments and formatting. IDs are left out on purpose: `wrangler deploy`
auto-provisions D1/KV/R2 on first deploy, and local dev works immediately. Hyperdrive needs a real config id
(`wrangler hyperdrive create`) and, for dev, `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING>`.
`wrangler.toml` is not edited automatically (the command tells you what to add by hand).

## D1 migrations

```bash
bunx cf-lite db new add_posts         # migrations/0002_add_posts.sql (next free number, never overwrites)
bunx cf-lite db status                # local: which migrations are pending
bunx cf-lite db apply                 # local, idempotent (applied ones are skipped)
bunx cf-lite db status --remote
bunx cf-lite db apply --remote --yes  # REMOTE. Refused without --yes.
```

`--db <binding>` picks one of several databases, `--env <name>` uses that environment's `d1_databases`,
`migrations_dir` from the wrangler entry is honoured. Migrations are forward-only: never edit one that has shipped.

### D1 Sessions (read replicas)

```ts
import { d1, d1Session } from "cf-lite/modules/d1";
const s = d1Session(env.DB, request);            // bookmark from the cf-lite d1 cookie / x-d1-bookmark
const rows = await d1(s.db).all("select * from posts");
return s.commit(Response.json(rows));            // stores the newest bookmark (Set-Cookie)
```

A visitor's reads never go back in time relative to their own earlier requests. Don't `commit` a publicly cached
response (it sets a cookie). Bookmarks from the client are validated (`[A-Za-z0-9._-]{1,256}`) before use.
Whether replicas are enabled for your database is an account/D1 setting; the helper works either way.

## KV

```ts
import { kv } from "cf-lite/modules/kv";
const flags = kv<{ on: boolean }>(env.KV, { prefix: "flag:", ttl: 3600 });
await flags.put("beta", { on: true });
await flags.get("beta");
for await (const key of flags.keys()) { /* all keys, follows cursors */ }
```

TTLs under KV's 60 s floor are clamped up. Do not use KV for anything that must be read back immediately
from another location.

## R2

```ts
import { uploadStream, UploadError, serveObject, presignUrl, multipartHandler } from "cf-lite/modules/r2";
```

* **`uploadStream(bucket, key, request, { maxBytes, allowTypes, sniff })`** - constant-memory streaming. With a
  `Content-Length` the body is piped into R2; without one (chunked) it is split into multipart parts (8 MiB).
  The cap is enforced on the declared length **and** on the bytes actually streamed (413, nothing stored; a
  half-done multipart upload is aborted). `allowTypes` takes exact types or `image/*`; `sniff: true` also checks
  magic bytes (png/jpeg/gif/webp/pdf/zip) so a renamed HTML file can't pass as an image (415). Zero-length is 400.
  Throws `UploadError` (`.status`, `.toResponse()`). Workers' request body limit applies (100 MB on Free/Pro).
* **`presignUrl(cfg, "GET"|"PUT"|"HEAD"|"DELETE", key, { expiresIn, contentType })`** - SigV4 query presign against
  `https://<account>.r2.cloudflarestorage.com/<bucket>/<key>`. Needs an R2 API token (access key id + secret) stored as
  Worker secrets. A pinned `contentType` is signed, so the client must send exactly that header. Max 7 days.
* **`multipartHandler(bucket, { prefix, authorize, maxBytes, allowTypes })`** - one handler for create / upload part /
  complete / abort; resume = keep the `uploadId`, send the missing parts, complete. Keys can't escape `prefix`.
  Parts must be >= 5 MiB except the last. Always pass `authorize`.
* **`serveObject(bucket, request, key, { cacheControl, download })`** - GET/HEAD with `ETag`, `Last-Modified`,
  `Accept-Ranges`, `206`/`416`, `304` (If-None-Match wins over If-Modified-Since), `If-Range`, `nosniff`, and a
  header-injection-safe `Content-Disposition`. Multi-range requests are answered with the full body (allowed by RFC 9110).

Image pipeline hook: store originals with `uploadStream`, serve variants through the images module when it lands.

Local-dev caveat: in `wrangler dev` (miniflare's proxy), answering 413/415 *before* reading a body that is already in
flight can make the next request on that connection fail with "Network connection lost". It is a dev-proxy artefact
(the deployed runtime is unaffected); the e2e script orders its rejection cases accordingly.

## Hyperdrive

```ts
import postgres from "postgres";
import { withHyperdrive } from "cf-lite/modules/hyperdrive";
const rows = await withHyperdrive(env.HYPERDRIVE, ctx, (url) => postgres(url, { max: 1 }), (sql) => sql`select * from posts`);
```

One short-lived client per request; it is closed with `ctx.waitUntil` after the response path, on success **and** on
error. `hyperdrive()` is the manual form (`{ client, close }`). Bring your own driver.

## Testing

`test/storage*.test.ts`: unit tests with fakes, workerd tests through `wrangler dev` with real R2/KV/D1 bindings,
a real-wrangler migration test (apply, idempotent re-apply, incremental apply, remote refusal), and a presign
round trip against a local S3-style verifier written independently of the signer (plus the AWS SigV4 documentation
vector). `scripts/storage-e2e.mjs` runs the example end to end. `scripts/r2-presign-smoke.mjs` is the nightly
real-bucket check (skips without `R2_*` env; needs a scratch bucket + token from the owner).
