import { notFound } from "cf-lite/navigation";
export const render = "ssr";
export async function loader() { notFound(); }
export default function Missing() { return <h1>unreachable</h1>; }
