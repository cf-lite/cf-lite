import { HibernatingRoom } from "cf-lite/modules/realtime";

type Meta = { name: string };
type Msgs = { chat: { text: string } };

/** One instance per room name. Sockets hibernate between messages; presence, history and resume come from the base class. */
export default class Chat extends HibernatingRoom<Env, Meta, Msgs> {
  static options = { history: 50 };

  authorize(req: Request) {
    const name = new URL(req.url).searchParams.get("name")?.trim().slice(0, 32);
    if (!name) return new Response("name required", { status: 400 });
    return { meta: { name } };
  }

  messages = {
    chat: (conn: { id: string; meta: Meta }, d: Msgs["chat"]) => {
      const text = String(d?.text ?? "").slice(0, 500);
      if (text) return void this.broadcast("chat", { name: conn.meta.name, text }, { from: conn.id });
    },
  };
}
