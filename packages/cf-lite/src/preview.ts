/**
 * Component preview (`/__preview`, docs/preview.md): the public authoring helper.
 * `*.states.ts` next to a component names prop sets; the dev-only `/__preview` page renders each one through the real UI adapter
 * (SSR, islands hydrated). Runtime-neutral on purpose (states files are bundled for the Worker): the fs scan lives in `preview-scan.ts`.
 */
/** One named prop set: the props object, or a (possibly async) function returning it. */
export type StateProps<P> = P | (() => P | Promise<P>);
/** The shape a `*.states.ts` file default-exports (what `defineStates` returns). */
export interface StatesDef<P = Record<string, unknown>> {
  /** The component to render. Optional when the file sits next to the component (`Button.states.ts` + `Button.tsx`): the sibling's default export is used. */
  component?: unknown;
  /** Sidebar title (default: the file name without `.states.ts`). */
  title?: string;
  /** Sidebar group (default: the folder under `app/`). */
  group?: string;
  states: Record<string, StateProps<P>>;
}
type PropsOf<C> = C extends (props: infer P, ...rest: never[]) => unknown ? P : Record<string, unknown>;

/**
 * Typed states for a component:
 *
 *     export default defineStates(Button, { default: { label: "Save" }, disabled: { label: "Save", disabled: true } });
 *
 * Prop names and types are checked against the component (function components; for SFCs/classes props are untyped records).
 */
export function defineStates<C>(component: C, states: Record<string, StateProps<PropsOf<C>>>, meta: { title?: string; group?: string } = {}): StatesDef<PropsOf<C>> {
  return { component, states, ...meta };
}
