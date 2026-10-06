import { describe, expect, it } from "vitest";
import { matchPath, matchRoute } from "../src/client.js";

describe("client router matching", () => {
  it("matches params and splats", () => {
    expect(matchPath("/posts/:id", "/posts/42")).toEqual({ id: "42" });
    expect(matchPath("/docs/*", "/docs/a/b")).toEqual({ "*": "a/b" });
    expect(matchPath("/", "/")).toEqual({});
    expect(matchPath("/a", "/b")).toBeNull();
    expect(matchPath("/a/:x", "/a")).toBeNull();
    expect(matchPath("/a", "/a/b")).toBeNull();
  });
  it("first matching route wins", () => {
    const r = [{ path: "/x" }, { path: "/:y" }] as any;
    expect(matchRoute(r, "/x")!.route.path).toBe("/x");
    expect(matchRoute(r, "/z")!.params).toEqual({ y: "z" });
  });
});
