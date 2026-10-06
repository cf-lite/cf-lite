import app from "../../.cf-lite/app";
import { isrConsumer } from "cf-lite/modules/isr";

// Queue "isr": regenerates pages by calling the app itself; `isr()` routes recognise the consumer's one-shot nonce header.
export default isrConsumer({ render: (req, env, ctx) => app.fetch(req, env, ctx) });
