export const match = ["support@example.com", "*@help.example.com"];

export default async (message: ForwardableEmailMessage, env: Env) => {
  await env.STATE.put(`email:${message.to}`, message.from);
};
