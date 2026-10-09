// Protocol-level tests against a real server process: raw JSON-RPC over HTTP
// (no SDK on the client side) plus the official SDK client.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = 8799;
const URL_ = `http://127.0.0.1:${PORT}/mcp`;
let proc: ChildProcess;

before(async () => {
  proc = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: ":memory:", AGENT_MODE: "rules", WEB_DIST: "__none__" }, stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) {
        // Fixed demo morning so dose-gap assertions don't depend on the hour the tests run.
        await fetch(`http://127.0.0.1:${PORT}/api/reset`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ time: "10:00" }) });
        return;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
});
after(() => { proc.kill(); });

const rpc = (body: unknown, headers: Record<string, string> = {}) => fetch(URL_, {
  method: "POST", body: JSON.stringify(body),
  headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25", ...headers },
});

test("raw JSON-RPC: initialize negotiates 2025-11-25", async () => {
  const r = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "raw", version: "1" } } });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.result.protocolVersion, "2025-11-25");
  assert.equal(j.result.serverInfo.name, "carecircle");
  assert.ok(j.result.capabilities.tools);
});

test("raw JSON-RPC: tools/list exposes 20 tools with schemas and annotations", async () => {
  const j = await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
  const tools = j.result.tools;
  assert.equal(tools.length, 20);
  for (const t of tools) { assert.ok(t.description.length > 20, t.name); assert.equal(t.inputSchema.type, "object"); }
  assert.equal(tools.find((t: any) => t.name === "list_medications").annotations.readOnlyHint, true);
  assert.equal(tools.find((t: any) => t.name === "cancel_appointment").annotations.destructiveHint, true);
});

test("raw JSON-RPC: invalid arguments are rejected, unknown method is a JSON-RPC error", async () => {
  const bad = await (await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "forecast_refills", arguments: { horizon_days: 999 } } })).json();
  assert.ok(bad.error || bad.result?.isError, "out-of-range argument must fail");
  const unk = await (await rpc({ jsonrpc: "2.0", id: 4, method: "no/such" })).json();
  assert.equal(unk.error.code, -32601);
});

test("GET /mcp is 405 on this stateless server", async () => {
  assert.equal((await fetch(URL_, { headers: { Accept: "text/event-stream" } })).status, 405);
});

test("SDK client: full flow changes persistent state and errors are structured", async () => {
  const c = new Client({ name: "test", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(URL_)));
  const call = async (name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: args })).structuredContent as any;

  const before = await call("forecast_refills", {});
  const amlo = before.data.find((m: any) => m.medication === "Amlodipine");
  const r1 = await call("record_dose", { medication: "BP pill", recorded_by: "test" });
  assert.equal(r1.ok, true);
  assert.equal(r1.data.pills_left, amlo.pills_left - 1);
  const r2 = await call("record_dose", { medication: "BP pill" });
  assert.equal(r2.data.status, "possible_duplicate");
  assert.equal(r2.data.changed, false);

  const p = await call("request_refill", { medication: "Amlodipine" });
  assert.equal(p.data.status, "awaiting_confirmation");
  const done = await call("confirm_action", { confirmation_id: p.data.confirmation_id, approve: true, confirmed_by: "test" });
  assert.equal(done.data.status, "done");
  const again = await call("confirm_action", { confirmation_id: p.data.confirmation_id, approve: true });
  assert.equal(again.error.code, "ALREADY_RESOLVED");
  await c.close();
});

test("agent endpoint streams MCP steps and a final reply", async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/agent/chat`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ history: [{ role: "user", text: "A caller wants my OTP and says install AnyDesk" }] }) });
  const ev = (await r.text()).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(ev.filter((e) => e.type === "mcp").map((e) => e.method), ["initialize", "tools/list"]);
  assert.equal(ev.find((e) => e.type === "mcp").protocolVersion, "2025-11-25");
  assert.ok(ev.some((e) => e.type === "tool_call" && e.name === "assess_scam_risk"));
  assert.match(ev.at(-1).text, /scam/i);
});
