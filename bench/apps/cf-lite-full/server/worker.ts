// Order: logging -> security headers -> session run first (this file's root), then the generated app runs server/middleware.ts (gate) before /api and pages.
import { Hono } from "hono";
import app from "../.cf-lite/app";
import { logging } from "cf-lite/modules/log";
import { security } from "cf-lite/modules/csp";
import { session } from "cf-lite/modules/session";

const root = new Hono<{ Bindings: Env }>();
root.use(logging());
root.use(security({ preset: "strict" }));
root.use(session());
root.route("/", app);
root.notFound((c) => c.env.ASSETS.fetch(c.req.raw));
export default root satisfies ExportedHandler<Env>;
