"use server";
// Form-based server actions (docs/design/rsc.md section 11). Only app/actions/** and *.actions.ts may carry "use server".
import { getRequest, notFound, redirect } from "cf-lite/rsc";
import { guestbook } from "../lib/guestbook-store";

export async function sign(form: FormData): Promise<void> {
  const name = String(form.get("name") ?? "").trim().slice(0, 40);
  if (name === "boom") throw new Error("SECRET-action-boom");
  if (name === "go") redirect("/rsc-pure");
  if (name === "nf") notFound();
  if (name) guestbook.names.push(name);
  guestbook.lastUrl = getRequest().url.pathname; // request context (ALS) is available inside actions
}
export async function clear(): Promise<void> { guestbook.names.length = 0; }
