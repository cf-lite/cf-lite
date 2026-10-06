import { useState } from "react";

export const render = "static";
export const hydrate = true;
export const loader = () => ({ built: "static-build" }); // inline __CF_LITE_DATA__ script -> hashed in the CSP

export default function Home({ data }: { data: { built: string } }) {
  const [n, setN] = useState(0);
  return <main><h1>Security</h1><p data-testid="built">{data.built}</p><button data-testid="inc" onClick={() => setN(n + 1)}>count {n}</button></main>;
}
