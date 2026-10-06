import { describe, expect, it } from "vitest";
import { parseActionRequest, readLimited } from "../src/modules/rsc-action.js";

const same = { origin: "http://x.test", "sec-fetch-site": "same-origin" };
const req = (body: BodyInit | null, headers: Record<string, string> = same, method = "POST") => new Request("http://x.test/p", { method, body, headers });
const form = (f: Record<string, string>) => { const fd = new FormData(); for (const [k, v] of Object.entries(f)) fd.append(k, v); return fd; };
const ID = "$ACTION_ID_abc123#sign";

describe("parseActionRequest (hostile inputs)", () => {
  it("accepts one well-formed id, strips it, keeps the other fields", async () => {
    const r = await parseActionRequest(req(form({ [ID]: "", name: "a" })));
    expect(r).toMatchObject({ ok: true, id: "abc123#sign" });
    if (r.ok) { expect([...r.form.keys()]).toEqual(["name"]); }
    const u = await parseActionRequest(req(new URLSearchParams({ [ID]: "", n: "1" }), { ...same, "content-type": "application/x-www-form-urlencoded" }));
    expect(u.ok).toBe(true);
  });
  it("refuses non-POST, cross-origin, missing origin, wrong content type", async () => {
    expect(await parseActionRequest(req(null, same, "PUT"))).toMatchObject({ ok: false, status: 405 });
    expect(await parseActionRequest(req(form({ [ID]: "" }), { origin: "http://evil.test", "sec-fetch-site": "cross-site" }))).toMatchObject({ ok: false, status: 403 });
    expect(await parseActionRequest(req(form({ [ID]: "" }), { origin: "http://evil.test" }))).toMatchObject({ ok: false, status: 403 });
    expect(await parseActionRequest(req(form({ [ID]: "" }), {}))).toMatchObject({ ok: false, status: 403 });
    expect(await parseActionRequest(req("[]", { ...same, "content-type": "application/json" }))).toMatchObject({ ok: false, status: 415 });
    expect(await parseActionRequest(req("0:[]", { ...same, "content-type": "text/x-component" }))).toMatchObject({ ok: false, status: 415 });
  });
  it("refuses oversized bodies by content-length and when streamed without one", async () => {
    expect((await parseActionRequest(req(form({ [ID]: "", a: "x".repeat(5000) })))).ok).toBe(true); // under the 1 MiB default
    expect(await parseActionRequest(req(form({ [ID]: "", a: "x".repeat(5000) })), { maxBytes: 1000 })).toMatchObject({ ok: false, status: 413 });
    // streamed without content-length (the workerd e2e covers the same through a real Request): a plain {headers, body} avoids undici's body-pump quirk
    const streamed = () => ({ headers: new Headers(), body: new ReadableStream<Uint8Array>({ start(c) { for (let i = 0; i < 6; i++) c.enqueue(new Uint8Array(4096)); c.close(); } }) });
    expect(await readLimited(streamed(), 10_000)).toBeNull();
    expect((await readLimited(streamed(), 100_000))?.byteLength).toBe(6 * 4096);
    expect(await readLimited(new Request("http://x.test/", { method: "POST", body: "x", headers: { "content-length": "abc" } }), 10)).toBeNull();
  });
  it("refuses forged / malformed / multiple / bound action ids and broken multipart", async () => {
    for (const bad of ["nohash", "a#", "#b", "a#b c", "a#__proto__", "a#constructor", "a#toString", "../x#y\n", "a".repeat(400) + "#b", "a#1x"]) {
      expect(await parseActionRequest(req(form({ ["$ACTION_ID_" + bad]: "" }))), bad).toMatchObject({ ok: false, status: 400 });
    }
    expect(await parseActionRequest(req(form({ [ID]: "", "$ACTION_ID_d#e": "" })))).toMatchObject({ ok: false, status: 400 });
    expect(await parseActionRequest(req(form({ $ACTION_REF_1: "", "$ACTION_1:0": "[]" })))).toMatchObject({ ok: false, status: 400 });
    expect(await parseActionRequest(req(form({ [ID]: "", $ACTION_KEY: "k" })))).toMatchObject({ ok: false, status: 400 });
    expect(await parseActionRequest(req(form({ name: "no id" })))).toMatchObject({ ok: false, status: 400 });
    expect(await parseActionRequest(req("--x\r\ngarbage", { ...same, "content-type": "multipart/form-data; boundary=x" }))).toMatchObject({ ok: false, status: 400 });
    const many = form({ [ID]: "" }); for (let i = 0; i < 300; i++) many.append("f" + i, "1");
    expect(await parseActionRequest(req(many))).toMatchObject({ ok: false, status: 413 });
  });
});
