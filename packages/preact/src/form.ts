import { h, createContext, type ComponentChildren, type JSX } from "preact";
import { useContext, useEffect, useRef, useState } from "preact/hooks";
import { enhance, type ActionResult, type EnhanceOptions } from "cf-lite/modules/form";

export { enhance, actionDataOf, onActionResult, type ActionResult, type EnhanceOptions } from "cf-lite/modules/form";

export interface FormStatus<T = unknown> { pending: boolean; result: ActionResult<T> | null }
const Ctx = createContext<FormStatus>({ pending: false, result: null });
/** Inside a `<Form>`: `{ pending, result }` of the last submission (`result.data` = the action's return / `fail()` payload). */
export const useFormStatus = <T = unknown>() => useContext(Ctx) as FormStatus<T>;

/** `<Form action="?/save">`: a normal post form that, once hydrated, submits with fetch (pending state, double-submit guard, client-side redirects). */
export function Form<T = unknown>({ onResult, optimistic, onPending, children, ...rest }: Omit<JSX.HTMLAttributes<HTMLFormElement>, "method" | "onResult"> & Pick<EnhanceOptions<T>, "onResult" | "optimistic" | "onPending"> & { children?: ComponentChildren }) {
  const ref = useRef<HTMLFormElement>(null);
  const [st, setSt] = useState<FormStatus<T>>({ pending: false, result: null });
  const opts = useRef<EnhanceOptions<T>>({});
  opts.current = { optimistic, onPending: (p) => { setSt((s) => ({ ...s, pending: p })); onPending?.(p); }, onResult: (r, f) => { setSt({ pending: false, result: r }); return onResult?.(r, f); } };
  useEffect(() => {
    const hd = enhance<T>(ref.current!, { optimistic: (d) => opts.current.optimistic?.(d), onPending: (p) => opts.current.onPending?.(p), onResult: (r, f) => opts.current.onResult?.(r, f) });
    return hd.destroy;
  }, []);
  return h(Ctx.Provider, { value: st as FormStatus }, h("form", { ...rest, method: "post", ref, "aria-busy": st.pending }, children));
}
