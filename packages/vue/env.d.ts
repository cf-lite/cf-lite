declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{ params?: Record<string, string>; data?: any }, {}, any>;
  export default component;
}
