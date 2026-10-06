import { defineStates } from "cf-lite/preview";
import Counter from "./Counter.island";

export default defineStates(Counter, { default: { start: 0 }, "from-ten": { start: 10 } });
