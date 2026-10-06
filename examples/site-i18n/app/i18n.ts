import { loadMessages, translator } from "cf-lite/modules/i18n";
import { i18n } from "../.cf-lite/i18n";

export { i18n };
/** One dynamic import per locale = one chunk per locale; a route only bundles what it imports. */
const catalogs = { en: () => import("./messages/en.json"), vi: () => import("./messages/vi.json") };
export const load = (locale: string) => loadMessages(i18n, catalogs as never, locale);
export { translator };
