/** Runtime of the `server/email/*.ts` convention: route an inbound message to the first file whose `match` fits the recipient. */
export type EmailHandler = (message: ForwardableEmailMessage, env: any, ctx: ExecutionContext) => void | Promise<void>;
export interface EmailRoute { name: string; /** Exact addresses, `*@domain`, `user@*` or `*`; omitted = catch-all. */ match?: string[]; run: EmailHandler }

export function addressMatches(pattern: string, address: string): boolean {
  const p = pattern.trim().toLowerCase(), a = address.trim().toLowerCase();
  if (p === "*") return true;
  if (p.startsWith("*@")) return a.endsWith(p.slice(1));
  if (p.endsWith("@*")) return a.startsWith(p.slice(0, -1));
  return p === a;
}

export function pickEmailRoute(routes: EmailRoute[], to: string): EmailRoute | undefined {
  return routes.find((r) => r.match?.some((m) => addressMatches(m, to))) ?? routes.find((r) => !r.match);
}

export async function dispatchEmail(routes: EmailRoute[], message: ForwardableEmailMessage, env: unknown, ctx: ExecutionContext): Promise<void> {
  const route = pickEmailRoute(routes, message.to);
  if (!route) { message.setReject(`No server/email route for ${message.to}`); return; }
  await route.run(message, env, ctx);
}
