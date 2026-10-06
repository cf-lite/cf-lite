export const render = "rsc";
export const head = ({ url }: { url?: string }) => ({ title: "deep page", meta: [{ name: "x-url", content: url ?? "" }] });

export default function Deep() { return <p id="deep">deep page</p>; }
