// CONTROL: the thinnest possible Worker. Every route goes through the Worker, no framework, no Hono.
// Its latency is the floor of the local launcher (vite preview / wrangler dev) for a Worker-invoking request.
export default {
  fetch(req: Request) {
    const p = new URL(req.url).pathname;
    if (p === "/go/example") return Response.redirect("https://example.com/", 302);
    if (p === "/api/hello") return Response.json({ message: "hello" });
    return new Response("<!doctype html><title>bench</title><main><h1>About</h1></main>", { headers: { "content-type": "text/html" } });
  },
} satisfies ExportedHandler;
