import { defineStates } from "cf-lite/preview";
import Button from "./Button";

export default defineStates(Button, {
  default: { label: "Add to cart" },
  ghost: { label: "Details", variant: "ghost" },
  disabled: { label: "Sold out", disabled: true },
});
