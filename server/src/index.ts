import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { openDb } from "./db.js";
import { buildMcpServer } from "./mcp.js";
import { resetDemo } from "./seed.js";
import { activityLog, systemClock } from "./care.js";
import { agentRouter } from "./agent.js";

const PORT = Number(process.env.PORT ?? 8787);
const db = openDb(process.env.DB_PATH ?? "data/carecircle.db");
if (!db.prepare("SELECT 1 FROM people LIMIT 1").get()) resetDemo(db, systemClock());

const app = express();
app.use(express.json({ limit: "256kb" }));

// ---- MCP endpoint: Streamable HTTP, stateless (fresh server+transport per request) ----
app.post("/mcp", async (req, res) => {
  const server = buildMcpServer(db, systemClock);
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
app.post("/api/reset", (_req, res) => { resetDemo(db, systemClock()); res.json({ ok: true }); });
app.use("/api/agent", agentRouter(`http://127.0.0.1:${PORT}/mcp`));

// ---- static web client (built by ../web) ----
const webDist = resolve(process.env.WEB_DIST ?? "../web/dist");
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^\/(?!api|mcp).*/, (_req, res) => res.sendFile(resolve(webDist, "index.html")));
}

app.listen(PORT, () => console.log(`CareCircle on http://localhost:${PORT}  (MCP: /mcp)`));
