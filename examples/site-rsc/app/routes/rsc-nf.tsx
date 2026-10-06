import { notFound } from "cf-lite/rsc";
export const render = "rsc";
export default async function Page() { await Promise.resolve(); notFound(); }
