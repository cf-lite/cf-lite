import { defineMock } from "cf-lite/modules/mock";

const names: Record<string, string> = { "1": "Oak shelf", "2": "Linen sofa" };

// any method; ctx = { request, url, params, query, body }
export default defineMock(({ params }) => {
  const name = names[params.id!];
  return name ? { id: Number(params.id), name } : new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
});
