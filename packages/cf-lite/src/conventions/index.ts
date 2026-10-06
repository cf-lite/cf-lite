/** Built-in convention contributors, in emit order. A new built-in = one file here + one entry in this array. */
import { apiConvention } from "./api.js";
import { cronConvention } from "./cron.js";
import { emailConvention } from "./email.js";
import { metadataConvention } from "./metadata.js";
import { obsConvention } from "./obs.js";
import { middlewareConvention } from "./middleware.js";
import { pagesConvention } from "./pages.js";
import { routesConvention } from "./routes.js";
import { queuesConvention } from "./queues.js";
import { workflowsConvention } from "./workflows.js";
import { doConvention } from "./do.js";
import { isrConvention } from "./isr.js";
import { typegenConvention } from "./typegen.js";
import { previewConvention } from "./preview.js";
import { mocksConvention } from "./mocks.js";
import type { Convention } from "./types.js";

export const builtinConventions: Convention<any>[] = [previewConvention, apiConvention, middlewareConvention, mocksConvention, routesConvention, cronConvention, queuesConvention, workflowsConvention, emailConvention, doConvention, obsConvention, metadataConvention, pagesConvention, isrConvention, typegenConvention];
export { obsConvention, metrics } from "./obs.js";
export { isrConvention } from "./isr.js";
export { typegenConvention } from "./typegen.js";
export { previewConvention } from "./preview.js";
export { mocksConvention } from "./mocks.js";
export { apiConvention, middlewareConvention, pagesConvention, routesConvention, cronConvention, queuesConvention, workflowsConvention, emailConvention, doConvention, metadataConvention };
export { compileMatcher, compilePattern, fitWorkerFirst, RUN_WORKER_FIRST_LIMIT } from "./middleware.js";
export * from "./types.js";
export { genRoutes } from "./pages.js";
