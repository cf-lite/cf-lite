import { DurableObject } from "cloudflare:workers";

/** Hibernatable-WebSocket chat room. Exported verbatim from worker.ts. */
export class Room extends DurableObject<Env> {
  async fetch(_req: Request) {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].send(`welcome (${this.ctx.getWebSockets().length} connected)`);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
    for (const s of this.ctx.getWebSockets()) s.send(`echo: ${msg}`);
  }
  webSocketClose(ws: WebSocket) { ws.close(); }
}
