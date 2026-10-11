import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { resolve } from "node:path";
import { openDb } from "./db.js";
import { buildMcpServer } from "./mcp.js";
import { resetDemo } from "./seed.js";
import { activityLog, type Clock } from "./care.js";
import { agentRouter } from "./agent.js";
import { runEscalations, syncKnownPeople } from "./family.js";
import { photoPath, savePhoto, visionHealth } from "./vision.js";

const PORT = Number(process.env.PORT ?? 8787);
const db = openDb(process.env.DB_PATH ?? "data/carecircle.db");

// Demo clock: real time plus an offset. "Reset demo" can start the day at a chosen
// time (e.g. 10:00) so the demo and the eval are reproducible at any hour.
let offsetMs = 0;
const clock: Clock = () => new Date(Date.now() + offsetMs);
if (!db.prepare("SELECT 1 FROM people LIMIT 1").get()) resetDemo(db, clock());
syncKnownPeople(db);

const app = express();
app.use(express.json({ limit: "256kb" }));

// ---- MCP endpoint: Streamable HTTP with sessions ----
// Sessions let the server send requests back to the client in the middle of a
// tool call (elicitation: "Approve this refill?") and route the answer, which
// arrives as a separate POST, to the same server instance.
type Session = { transport: StreamableHTTPServerTransport; server: ReturnType<typeof buildMcpServer>; seen: number };
const sessions = new Map<string, Session>();
const SESSION_IDLE_MS = 30 * 60_000;
const rpcError = (code: number, message: string) => ({ jsonrpc: "2.0", error: { code, message }, id: null });

app.post("/mcp", async (req, res) => {
  const sid = req.header("mcp-session-id");
  let s = sid ? sessions.get(sid) : undefined;
  try {
    if (sid && !s) return res.status(404).json(rpcError(-32001, "Session not found; initialize a new session."));
    if (!s) {
      if (!isInitializeRequest(req.body)) return res.status(400).json(rpcError(-32000, "No session: the first request must be initialize."));
      const server = buildMcpServer(db, clock);
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { sessions.set(id, { transport, server, seen: Date.now() }); },
        onsessionclosed: (id) => { sessions.delete(id); },
      });
      transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
      await server.connect(transport);
      s = { transport, server, seen: Date.now() };
    }
    s.seen = Date.now();
    await s.transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("[mcp]", e);
    if (!res.headersSent) res.status(500).json(rpcError(-32603, "Internal error"));
  }
});
// GET opens the optional standalone SSE stream; DELETE ends a session.
const bySession = async (req: express.Request, res: express.Response) => {
  const s = sessions.get(req.header("mcp-session-id") ?? "");
  if (!s) return res.status(req.header("mcp-session-id") ? 404 : 400).json(rpcError(-32000, "Missing or unknown Mcp-Session-Id"));
  s.seen = Date.now();
  await s.transport.handleRequest(req, res);
};
app.get("/mcp", bySession);
app.delete("/mcp", bySession);
setInterval(() => {
  for (const [id, s] of sessions) if (Date.now() - s.seen > SESSION_IDLE_MS) { s.transport.close(); sessions.delete(id); }
}, 60_000).unref();

// ---- demo/meta endpoints (not part of the MCP surface) ----
app.get("/api/health", async (_req, res) => res.json({ ok: true, mcp: "/mcp", protocol: "2025-11-25", transport: "streamable-http", sessions: sessions.size, vision: await visionHealth() }));

// ---- strip-check photos: upload raw JPEG/PNG bytes, get an id the MCP tools accept ----
app.post("/api/vision/photo", express.raw({ type: ["image/jpeg", "image/png"], limit: "12mb" }), (req, res) => {
  try {
    if (!Buffer.isBuffer(req.body)) return res.status(415).json({ ok: false, error: "Send image/jpeg or image/png bytes" });
    res.json({ ok: true, photo_id: savePhoto(req.body) });
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e?.message ?? "bad photo" });
  }
});
app.get("/api/vision/photo/:id/annotated", (req, res) => {
  const p = photoPath(req.params.id, true);
  if (!p) return res.status(404).end();
  res.set("Cache-Control", "no-store").type("jpeg").sendFile(p);
});
app.get("/api/activity", (_req, res) => res.json(activityLog(db, 40)));
app.get("/api/clock", (_req, res) => res.json({ now: clock().toString(), simulated: offsetMs !== 0 }));
// Demo control: move the demo clock forward (e.g. to show the escalation ladder on camera).
app.post("/api/clock/advance", (req, res) => {
  const minutes = Number(req.body?.minutes);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 24 * 60) return res.status(400).json({ ok: false, error: "minutes must be 1-1440" });
  offsetMs += minutes * 60_000;
  const escalated = runEscalations(db, clock());
  res.json({ ok: true, now: clock().toString(), simulated: true, escalated });
});
app.post("/api/reset", (req, res) => {
  const time = req.body?.time;
  if (time !== undefined && (typeof time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)))
    return res.status(400).json({ ok: false, error: "time must be HH:MM" });
  if (time) {
    const [h, m] = time.split(":").map(Number);
    const target = new Date(); target.setHours(h, m, 0, 0);
    offsetMs = target.getTime() - Date.now();
  } else offsetMs = 0;
  resetDemo(db, clock());
  res.json({ ok: true, now: clock().toString(), simulated: offsetMs !== 0 });
});
app.use("/api/agent", agentRouter(`http://127.0.0.1:${PORT}/mcp`, clock));

// ---- static web client (built by ../web) ----
const webDist = resolve(process.env.WEB_DIST ?? "../web/dist");
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^\/(?!api|mcp).*/, (_req, res) => res.sendFile(resolve(webDist, "index.html")));
}

// Escalations also advance on their own, not only when someone reads the alerts.
setInterval(() => { try { runEscalations(db, clock()); } catch (e) { console.error("[escalation]", e); } }, 15_000).unref();

app.listen(PORT, () => console.log(`CareCircle on http://localhost:${PORT}  (MCP: /mcp)`));
