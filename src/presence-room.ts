import { DurableObject } from "cloudflare:workers";
import { validateRunPayload, type RunRecord } from "./validation";

export class PresenceRoom extends DurableObject {
  fetch(request: Request): Response {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    this.broadcastPeers();
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string" || message.length > 4096) return;
    let payload;
    try {
      payload = JSON.parse(message);
    } catch {
      return;
    }
    if (payload?.type !== "presence") return;
    const run = validateRunPayload(payload.run);
    if (!run) return;
    socket.serializeAttachment(run);
    this.broadcastPeers();
  }

  webSocketClose(socket: WebSocket, code: number, reason: string): void {
    if (code === 1005 || code === 1006 || code === 1015) socket.close();
    else socket.close(code, reason);
    this.broadcastPeers(socket);
  }

  webSocketError(socket: WebSocket): void {
    socket.close(1011, "WebSocket error");
    this.broadcastPeers(socket);
  }

  broadcastBoardUpdate(): void {
    this.broadcast(this.ctx.getWebSockets(), { type: "board_update" });
  }

  private broadcastPeers(exclude?: WebSocket): void {
    const sockets = this.ctx.getWebSockets().filter(socket => socket !== exclude && socket.readyState === WebSocket.OPEN);
    const peers = new Map<string, RunRecord>();
    for (const socket of sockets) {
      const run: RunRecord | null = socket.deserializeAttachment();
      if (run && (!peers.has(run.id) || run.ts >= peers.get(run.id)!.ts)) peers.set(run.id, run);
    }
    this.broadcast(sockets, { type: "peers", peers: [...peers.values()] });
  }

  private broadcast(sockets: WebSocket[], payload: object): void {
    const message = JSON.stringify(payload);
    for (const socket of sockets) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      try {
        socket.send(message);
      } catch {
        // The peer may have disconnected during this broadcast.
      }
    }
  }
}
