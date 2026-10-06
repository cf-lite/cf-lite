import { Hono } from "hono";
export default new Hono<{ Bindings: Env }>().get("/", (c) => c.json({ message: "hello" }));
