// cache + a `keepParams` allowlist that does NOT list `__rsc`: HTML and Flight payload must still be separate cache entries (P4 review fix).
export const render = "rsc";
export const cache = { maxAge: 60 };
export const cacheKey = { keepParams: ["id"] };
export default function Page({ url }: { url: string }) { return <main><h1 id="mode">key {new URL(url).searchParams.get("id")}</h1></main>; }
