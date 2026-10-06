import { permanentRedirect } from "cf-lite/navigation";
export const render = "ssr";
export async function loader() { permanentRedirect("/pricing"); }
export default function Old() { return <h1>unreachable</h1>; }
