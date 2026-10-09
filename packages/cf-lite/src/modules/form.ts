/**
 * Browser-side progressive enhancement for `<form method="post" action="?/name">` (`cf-lite/modules/form`). Framework-free:
 * the React/Preact `Form`, Vue `vEnhance`, and Svelte `use:enhance` in the adapters are thin wrappers over `enhance()`.
 *
 * Without this code (or JS) the form still works: the browser posts, the Worker answers 303 or a re-rendered page.
 * With it: `fetch` instead of a page load, pending state + double-submit guard, action result delivered to callbacks,
 * redirects followed client-side, and a transparent fallback to a native submit if the fetch itself fails.
 */
import { visit } from "../client.js";

export const ACTION_HEADER = "x-cf-lite-action";

export type ActionResult<T = unknown> =
  | { type: "success"; status: number; data: T }
  | { type: "failure"; status: number; data: T }
  | { type: "redirect"; status: number; location: string }
  | { type: "error"; status: number };

export interface EnhanceOptions<T = unknown> {
  /** Called right before the request with the form data; return `false` to cancel (client-side validation). Mutate `data` to add fields. */
  onSubmit?(ctx: { form: HTMLFormElement; data: FormData; submitter: HTMLElement | null }): boolean | void;
  /** Pending flag changes (true on submit, false when settled). The form also gets `data-pending` and `aria-busy`. */
  onPending?(pending: boolean): void;
  /** Result of the action. Return `false` to skip the default handling (following redirects). */
  onResult?(result: ActionResult<T>, form: HTMLFormElement): boolean | void;
  /** Optimistic hook: runs synchronously on submit with the form data; call the returned function to roll back if the action fails. */
  optimistic?(data: FormData): (() => void) | void;
  /** Reset the form after a `success` result. Default true. */
  resetOnSuccess?: boolean;
}

const EVENT = "cf-lite:action";

/** Attach to a form. Returns a Svelte-action-shaped handle (`destroy`, `update`). */
export function enhance<T = unknown>(form: HTMLFormElement, options: EnhanceOptions<T> = {}): { destroy(): void; update(o: EnhanceOptions<T>): void } {
  let opts = options;
  let pending = false;
  const setPending = (p: boolean, submitter: HTMLElement | null) => {
    pending = p;
    form.toggleAttribute("data-pending", p);
    form.setAttribute("aria-busy", String(p));
    // disable (not just guard) the submit controls so assistive tech and users see that it is busy; the submitter keeps its name/value in `data`
    for (const b of form.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button:not([type="button"]), input[type="submit"]')) {
      if (p) { b.dataset.cfWasDisabled = String(b.disabled); b.disabled = true; } else { b.disabled = b.dataset.cfWasDisabled === "true"; delete b.dataset.cfWasDisabled; }
    }
    void submitter;
    opts.onPending?.(p);
  };

  async function onSubmit(e: SubmitEvent) {
    if (e.defaultPrevented) return;
    const method = ((e.submitter?.getAttribute("formmethod")) || form.method || "get").toLowerCase();
    if (method !== "post") return;
    e.preventDefault();
    if (pending) return; // double-submit guard
    const submitter = e.submitter as HTMLElement | null;
    const data = new FormData(form, submitter as HTMLElement | null);
    if (opts.onSubmit?.({ form, data, submitter }) === false) return;
    const rollback = opts.optimistic?.(data) ?? undefined;
    // the attribute, not `button.formAction`: browsers resolve the IDL getter inconsistently (Chromium drops the `?/name` query when the attribute is absent)
    const fa = submitter?.getAttribute("formaction");
    const action = fa ? new URL(fa, location.href).href : form.action;
    setPending(true, submitter);
    let result: ActionResult<T>;
    try {
      const res = await fetch(action, { method: "POST", body: data, headers: { [ACTION_HEADER]: "1", accept: "application/json" }, credentials: "same-origin" });
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("json")) {
        // CSRF 403, 413, 404 ... : not an action result. Replace the document with what the server said (a real navigation has the same outcome).
        throw new Error(`HTTP ${res.status}`);
      }
      result = (await res.json()) as ActionResult<T>;
    } catch {
      rollback?.();
      setPending(false, submitter);
      form.removeEventListener("submit", onSubmit);
      form.requestSubmit(submitter as HTMLElement | null); // native no-JS path: the server renders the outcome
      return;
    }
    setPending(false, submitter);
    if (result.type === "failure" || result.type === "error") rollback?.();
    form.dispatchEvent(new CustomEvent(EVENT, { detail: result, bubbles: true }));
    if (opts.onResult?.(result, form) === false) return;
    if (result.type === "redirect") visit(result.location);
    else if (result.type === "success" && opts.resetOnSuccess !== false) form.reset();
  }
  form.addEventListener("submit", onSubmit);
  return { destroy: () => form.removeEventListener("submit", onSubmit), update: (o) => { opts = o; } };
}

/** Subscribe to every action result of a form (bubbles: one listener on `document` sees all forms). */
export function onActionResult<T = unknown>(target: EventTarget, fn: (r: ActionResult<T>, form: HTMLFormElement) => void): () => void {
  const h = (e: Event) => fn((e as CustomEvent<ActionResult<T>>).detail, e.target as HTMLFormElement);
  target.addEventListener(EVENT, h);
  return () => target.removeEventListener(EVENT, h);
}

/** The server puts action output next to loader data: `data.actionData` (see modules/actions.ts `withActionData`). */
export const actionDataOf = <T = unknown>(pageData: unknown): T | undefined => (pageData && typeof pageData === "object" ? (pageData as { actionData?: T }).actionData : undefined);
