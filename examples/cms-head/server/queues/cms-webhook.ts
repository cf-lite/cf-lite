import { webhookConsumer } from "cf-lite/modules/webhook";

export const queue = "cms-webhook";
export const binding = "WEBHOOK_QUEUE";
// event -> tags content:<type>:<id> + content:<type>:*, and the `paths` the CMS reported (the mock sends the public route) -> ISR revalidateTag -> regeneration.
export default webhookConsumer();
