import { enhance, type EnhanceOptions } from "cf-lite/modules/form";
import { onCleanup } from "solid-js";

export { enhance, actionDataOf, onActionResult, type ActionResult, type EnhanceOptions } from "cf-lite/modules/form";

/** `<form method="post" action="?/save" ref={useEnhance({ onResult })}>`: attaches on mount, detaches with the owner. */
export function useEnhance<T = unknown>(opts: EnhanceOptions<T> = {}): (el: HTMLFormElement) => void {
  return (el) => { const h = enhance(el, opts); onCleanup(h.destroy); };
}
