import { Hono } from "hono";

export default new Hono().get("/", (c) => c.text(`og:${c.req.param("slug")}`));
