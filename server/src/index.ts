import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { openDb } from "./db.js";
import { buildMcpServer } from "./mcp.js";
import { resetDemo } from "./seed.js";
import { activityLog, type Clock } from "./care.js";
import { agentRouter } from "./agent.js";
import { runEscalations } from "./family.js";

const PORT = Number(process.env.PORT ?? 8787);
const db = openDb(process.env.DB_PATH ?? "data/carecircle.db");

// Demo clock: real time plus an offset. "Reset demo" can start the day at a chosen
// time (e.g. 10:00) so the demo and the eval are reproducible at any hour.
let offsetMs = 0;
const clock: Clock = () => new Date(Date.now() + offsetMs);
if (!db.prepare("SELECT 1 FROM people LIMIT 1").get()) resetDemo(db, clock());

const app = express();
app.use(express.json({ limit: "256kb" }));

// ---- MCP endpoint: Streamable HTTP, stateless (fresh server+transport per request) ----
app.post("/mcp", async (req, res) => {
  const server = buildMcpServer(db, clock);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("[mcp]", e);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
});
// Stateless server: no standalone SSE stream and no sessions to delete.
app.get("/mcp", (_req, res) => res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }));
app.delete("/mcp", (_req, res) => res.status(405).set("Allow", "POST").end());

// ---- demo/meta endpoints (not part of the MCP surface) ----
app.get("/api/health", (_req, res) => res.json({ ok: true, mcp: "/mcp", protocol: "2025-11-25", transport: "streamable-http" }));
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
