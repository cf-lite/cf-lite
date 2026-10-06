import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
export default function () {
  const demo = resolve(import.meta.dirname, "../../../examples/demo");
  execFileSync(process.execPath, [resolve(demo, "../../packages/cf-lite/dist/cli.js"), "build"], { cwd: demo, stdio: "pipe" });
}
