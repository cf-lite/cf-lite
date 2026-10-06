import { defineMock } from "cf-lite/modules/mock";

export default defineMock(({ body, query }) => ({ got: body, query }));
