// NIGHTLY, needs a scratch R2 bucket + API token (never run in PR CI). Real-R2 round trip of cf-lite/modules/r2 presigned URLs.
//   R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_BUCKET_NAME=scratch node scripts/r2-presign-smoke.mjs
// Skips (exit 0) when the variables are absent, so it is safe to wire into a scheduled workflow before the secrets exist.
import assert from "node:assert/strict";
import { presignUrl } from "../packages/cf-lite/dist/modules/r2.js";

const { R2_ACCOUNT_ID: accountId, R2_ACCESS_KEY_ID: accessKeyId, R2_SECRET_ACCESS_KEY: secretAccessKey, R2_BUCKET_NAME: bucket } = process.env;
if (!accountId || !accessKeyId || !secretAccessKey || !bucket) { console.log("r2 presign smoke: SKIPPED (no R2_* env)"); process.exit(0); }
const cfg = { accountId, accessKeyId, secretAccessKey, bucket };
const key = `cf-lite-smoke/${Date.now()} é+.txt`;
const put = await fetch(await presignUrl(cfg, "PUT", key, { contentType: "text/plain" }), { method: "PUT", body: "hello", headers: { "content-type": "text/plain" } });
assert.equal(put.status, 200, await put.text());
const get = await fetch(await presignUrl(cfg, "GET", key));
assert.equal(await get.text(), "hello");
const del = await fetch(await presignUrl(cfg, "DELETE", key), { method: "DELETE" });
assert.ok(del.status === 204 || del.status === 200, "delete " + del.status);
assert.equal((await fetch(await presignUrl(cfg, "GET", key))).status, 404);
console.log("r2 presign smoke OK");
