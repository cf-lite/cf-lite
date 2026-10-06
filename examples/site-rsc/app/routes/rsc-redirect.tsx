import { redirect } from "cf-lite/rsc";
export const render = "rsc";
export default async function Page() { await Promise.resolve(); redirect("/rsc-data?id=r", 302); }
