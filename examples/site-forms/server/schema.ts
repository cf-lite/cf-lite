import { defineAction, type Validation } from "cf-lite/modules/actions";

/** A plain function validator; a zod/valibot schema (Standard Schema) works the same way: `defineAction(z.object({...}), handler)`. */
export const contactSchema = (input: Record<string, unknown>): Validation<{ name: string; email: string; message: string }> => {
  const name = String(input.name ?? "").trim(), email = String(input.email ?? "").trim(), message = String(input.message ?? "").trim();
  const errors: Record<string, string> = {};
  if (!name) errors.name = "Name is required";
  if (!/^\S+@\S+\.\S+$/.test(email)) errors.email = "Enter a valid email";
  if (message.length < 5) errors.message = "Message needs at least 5 characters";
  return Object.keys(errors).length ? { errors } : { value: { name, email, message } };
};
export { defineAction };
