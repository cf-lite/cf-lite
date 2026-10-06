import type { Directive } from "vue";
import { enhance, type EnhanceOptions } from "cf-lite/modules/form";

export { enhance, actionDataOf, onActionResult, type ActionResult, type EnhanceOptions } from "cf-lite/modules/form";

type Handle = ReturnType<typeof enhance>;
const handles = new WeakMap<HTMLFormElement, Handle>();
/** `<form method="post" action="?/save" v-enhance="{ onResult }">`: progressive enhancement (pending state, double-submit guard, client-side redirects). */
export const vEnhance: Directive<HTMLFormElement, EnhanceOptions | undefined> = {
  mounted: (el, b) => { handles.set(el, enhance(el, b.value ?? {})); },
  updated: (el, b) => handles.get(el)?.update(b.value ?? {}),
  unmounted: (el) => { handles.get(el)?.destroy(); handles.delete(el); },
};
