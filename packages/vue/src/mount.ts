import { computed, createSSRApp, createApp, defineComponent, provide, shallowRef, onScopeDispose, type PropType } from "vue";
import { createRouter, type ClientRoute, type Router } from "cf-lite/client";
import { compose, PARAMS } from "./compose.js";

const Root = defineComponent({
  props: { router: { type: Object as PropType<Router>, required: true } },
  setup({ router }) {
    const view = shallowRef(router.current);
    onScopeDispose(router.subscribe((v) => (view.value = v)));
    provide(PARAMS, computed(() => view.value.params));
    return () => compose(view.value as never);
  },
});

export async function mount(routes: ClientRoute[], el: Element = document.getElementById("root")!) {
  const props = { router: await createRouter(routes) };
  (el.hasAttribute("data-ssr") ? createSSRApp : createApp)(Root, props).mount(el);
}
