import { redirect } from "cf-lite/navigation";
export const render = "ssr";
export async function loader() { redirect("/pricing"); }
export default function Go() { return <h1>unreachable</h1>; }
