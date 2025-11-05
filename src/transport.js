import { WebSocketServer, WebSocket } from "ws";

export function createWSS(httpServer, { path = "/ws", maxPayload = 8192, allowedOrigins = [], heartbeatMs = 30000, dbg = () => {} } = {}){
  const wss = new WebSocketServer({ noServer: true, maxPayload });

  function isOriginAllowed(origin, hostHeader){
    const o = String(origin || "").trim();
    if (allowedOrigins.length) return allowedOrigins.map(s => s.toLowerCase()).includes(o.toLowerCase());
    if (!o) return true;
    try { const u = new URL(o); return String(u.host).toLowerCase() === String(hostHeader || "").toLowerCase(); }
    catch { return false; }
  }

  httpServer.on("upgrade", (req, socket, head) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      if (url.pathname !== path) { socket.write("HTTP/1.1 404 Not Found\r\n\r\n"); socket.destroy(); return; }
      if (!isOriginAllowed(req.headers["origin"], req.headers["host"])) { socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    } catch {
      try { socket.write("HTTP/1.1 400 Bad Request\r\n\r\n"); } catch {}
      try { socket.destroy(); } catch {}
    }
  });

  let heartbeatTimer = null;
  function startHeartbeat(){
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
      const nowMs = Date.now();
      for (const ws of wss.clients) {
        const age = nowMs - (ws._lastPong || nowMs);
        if (ws._awaitingPong) ws._missedPongs = (ws._missedPongs|0) + 1; else ws._missedPongs = 0;
        if ((ws._missedPongs|0) >= 2 || age >= heartbeatMs * 2.1) {
          try { ws._closeReason = "heartbeat"; } catch {}
          try { ws.terminate(); } catch {}
          continue;
        }
        ws._awaitingPong = true;
        try { ws.ping(); } catch (err) { try { ws._closeReason = "ping-error"; } catch {}; try { ws.terminate(); } catch {} }
      }
    }, heartbeatMs);
  }
  wss.on("close", () => { if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; } });
  startHeartbeat();

  function broadcast(obj){ const msg = JSON.stringify(obj); wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); }); }
  function send(ws, obj){ try { ws.send(JSON.stringify(obj)); } catch {} }

  return { wss, broadcast, send };
}

