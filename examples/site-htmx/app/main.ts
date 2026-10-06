import htmx from "htmx.org";
import Alpine from "alpinejs";

(window as unknown as { htmx: typeof htmx }).htmx = htmx; // htmx attaches to window for hx-on / extensions
(window as unknown as { Alpine: typeof Alpine }).Alpine = Alpine;
Alpine.start();
