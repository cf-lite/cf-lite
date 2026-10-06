import { localizedEntries } from "cf-lite/modules/i18n";
import type { SitemapEntry } from "cf-lite/modules/sitemap";
import { i18n } from "../.cf-lite/i18n";

// Every unprefixed path x every locale, each with hreflang alternates (+ x-default).
export default (): SitemapEntry[] => localizedEntries(["/", "/about", "/posts/hello"], i18n);
