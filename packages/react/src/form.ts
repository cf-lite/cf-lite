import { createContext, createElement, useContext, useEffect, useRef, useState, type FormHTMLAttributes, type ReactNode } from "react";
import { enhance, type ActionResult, type EnhanceOptions } from "cf-lite/modules/form";

export { enhance, actionDataOf, onActionResult, type ActionResult, type EnhanceOptions } from "cf-lite/modules/form";

export interface FormStatus<T = unknown> { pending: boolean; result: ActionResult<T> | null }
const Ctx = createContext<FormStatus>({ pending: false, result: null });
/** Inside a `<Form>`: `{ pending, result }` of the last submission (`result.data` = the action's return / `fail()` payload). */
export const useFormStatus = <T = unknown>() => useContext(Ctx) as FormStatus<T>;

/**
 * `<Form action="?/save">`: a normal `<form method="post">` (works before hydration and with JS off) that, once hydrated,
 * submits with fetch, tracks pending state (double submit is ignored) and follows redirects client-side.
 */
export function Form<T = unknown>({ onResult, optimistic, onPending, children, ...rest }: Omit<FormHTMLAttributes<HTMLFormElement>, "method"> & Pick<EnhanceOptions<T>, "onResult" | "optimistic" | "onPending"> & { children?: ReactNode }) {
  const ref = useRef<HTMLFormElement>(null);
  const [st, setSt] = useState<FormStatus<T>>({ pending: false, result: null });
  const opts = useRef<EnhanceOptions<T>>({});
  opts.current = { optimistic, onPending: (p) => { setSt((s) => ({ ...s, pending: p })); onPending?.(p); }, onResult: (r, f) => { setSt({ pending: false, result: r }); return onResult?.(r, f); } };
  useEffect(() => {
    const h = enhance<T>(ref.current!, { optimistic: (d) => opts.current.optimistic?.(d), onPending: (p) => opts.current.onPending?.(p), onResult: (r, f) => opts.current.onResult?.(r, f) });
    return h.destroy;
  }, []);
  return createElement(Ctx.Provider, { value: st as FormStatus }, createElement("form", { ...rest, method: "post", ref, "aria-busy": st.pending }, children));
}
