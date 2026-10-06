import { notFound } from "cf-lite/rsc";
export const render = "rsc";
export const loader = () => notFound();
export default function Page() { return <p>unreachable</p>; }
