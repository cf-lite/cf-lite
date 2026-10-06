import { afterEach, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectPm } from "../src/pm.js";

const ua = process.env.npm_config_user_agent;
afterEach(() => { if (ua === undefined) delete process.env.npm_config_user_agent; else process.env.npm_config_user_agent = ua; });
const dir = (lock?: string) => { const d = mkdtempSync(join(tmpdir(), "pm-")); if (lock) writeFileSync(join(d, lock), ""); return d; };

it("the app's lockfile wins over the launcher", () => {
  process.env.npm_config_user_agent = "npm/11 node/v24";
  expect(detectPm(dir("bun.lock"))).toBe("bun");
  expect(detectPm(dir("pnpm-lock.yaml"))).toBe("pnpm");
  expect(detectPm(dir("yarn.lock"))).toBe("yarn");
  expect(detectPm(dir("package-lock.json"))).toBe("npm");
});

it("no lockfile: Bun first (running under Bun, or launched by bun), else the launcher, else npm", () => {
  process.env.npm_config_user_agent = "bun/1.4.0";
  expect(detectPm(dir())).toBe("bun");
  if (!process.versions.bun) {
    process.env.npm_config_user_agent = "pnpm/9";
    expect(detectPm(dir())).toBe("pnpm");
    delete process.env.npm_config_user_agent;
    expect(detectPm(dir())).toBe("npm");
  }
});
