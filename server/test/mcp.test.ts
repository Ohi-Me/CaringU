// Protocol-level tests against a real server process: raw JSON-RPC over HTTP
// (no SDK on the client side), the official SDK client, and MCP elicitation.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const URL_ = `${BASE}/mcp`;
let proc: ChildProcess;
const resetDemo = () => fetch(`${BASE}/api/reset`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ time: "10:00" }) });

before(async () => {
  proc = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: ":memory:", AGENT_MODE: "rules", WEB_DIST: "__none__" }, stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) {
        // Fixed demo morning so dose-gap assertions don't depend on the hour the tests run.
        await resetDemo();
        return;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
});
after(() => { proc.kill(); });

// ---------- raw JSON-RPC over Streamable HTTP ----------
const rpc = (body: unknown, headers: Record<string, string> = {}) => fetch(URL_, {
  method: "POST", body: JSON.stringify(body),
  headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25", ...headers },
});
/** Responses come back as an SSE stream (so the server can interleave elicitation requests). */
async function rpcResult(r: Response) {
  const text = await r.text();
  if ((r.headers.get("content-type") ?? "").includes("application/json")) return JSON.parse(text);
  const data = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5)));
  return data.find((m) => "result" in m || "error" in m);
}
let session = "";

test("raw JSON-RPC: initialize negotiates 2025-11-25 and opens a session", async () => {
  const r = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "raw", version: "1" } } });
  assert.equal(r.status, 200);
  session = r.headers.get("mcp-session-id") ?? "";
  assert.ok(session.length > 10, "server must assign Mcp-Session-Id");
  const j = await rpcResult(r);
  assert.equal(j.result.protocolVersion, "2025-11-25");
  assert.equal(j.result.serverInfo.name, "carecircle");
  assert.ok(j.result.capabilities.tools);
  assert.equal((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, { "Mcp-Session-Id": session })).status, 202);
});

test("raw JSON-RPC: tools/list exposes 23 tools with schemas and annotations", async () => {
  const j = await rpcResult(await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { "Mcp-Session-Id": session }));
  const tools = j.result.tools;
  assert.equal(tools.length, 23);
  for (const t of tools) { assert.ok(t.description.length > 20, t.name); assert.equal(t.inputSchema.type, "object"); }
  assert.equal(tools.find((t: any) => t.name === "list_medications").annotations.readOnlyHint, true);
  assert.equal(tools.find((t: any) => t.name === "cancel_appointment").annotations.destructiveHint, true);
});

test("raw JSON-RPC: invalid arguments are rejected, unknown method is a JSON-RPC error", async () => {
  const bad = await rpcResult(await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "forecast_refills", arguments: { horizon_days: 999 } } }, { "Mcp-Session-Id": session }));
  assert.ok(bad.error || bad.result?.isError, "out-of-range argument must fail");
  const unk = await rpcResult(await rpc({ jsonrpc: "2.0", id: 4, method: "no/such" }, { "Mcp-Session-Id": session }));
  assert.equal(unk.error.code, -32601);
});

test("session rules: no session -> 400, unknown session -> 404, DELETE ends a session", async () => {
  assert.equal((await rpc({ jsonrpc: "2.0", id: 5, method: "tools/list" })).status, 400);
  assert.equal((await rpc({ jsonrpc: "2.0", id: 6, method: "tools/list" }, { "Mcp-Session-Id": "nope" })).status, 404);
  assert.equal((await fetch(URL_, { headers: { Accept: "text/event-stream" } })).status, 400);
  const del = await fetch(URL_, { method: "DELETE", headers: { "Mcp-Session-Id": session, "MCP-Protocol-Version": "2025-11-25" } });
  assert.equal(del.status, 200);
  assert.equal((await rpc({ jsonrpc: "2.0", id: 7, method: "tools/list" }, { "Mcp-Session-Id": session })).status, 404);
});

// ---------- official SDK client ----------
test("SDK client: full flow changes persistent state and errors are structured", async () => {
  await resetDemo();
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

  // This client did not declare elicitation, so it gets the two-phase flow.
  const p = await call("request_refill", { medication: "Amlodipine" });
  assert.equal(p.data.status, "awaiting_confirmation");
  const done = await call("confirm_action", { confirmation_id: p.data.confirmation_id, approve: true, confirmed_by: "test" });
  assert.equal(done.data.status, "done");
  const again = await call("confirm_action", { confirmation_id: p.data.confirmation_id, approve: true });
  assert.equal(again.error.code, "ALREADY_RESOLVED");
  await c.close();
});

test("agent endpoint streams MCP steps and a final reply", async () => {
  const r = await fetch(`${BASE}/api/agent/chat`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ history: [{ role: "user", text: "A caller wants my OTP and says install AnyDesk" }] }) });
  const ev = (await r.text()).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(ev.filter((e) => e.type === "mcp").map((e) => e.method), ["initialize", "tools/list"]);
  assert.equal(ev.find((e) => e.type === "mcp").protocolVersion, "2025-11-25");
  assert.ok(ev.some((e) => e.type === "tool_call" && e.name === "assess_scam_risk"));
  assert.match(ev.at(-1).text, /scam/i);
});

// ---------- MCP elicitation: the server asks the human, not the model ----------
async function elicitingClient(answer: (message: string) => { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> }) {
  const asked: string[] = [];
  const c = new Client({ name: "device", version: "1" }, { capabilities: { elicitation: { form: {} } } });
  c.setRequestHandler(ElicitRequestSchema, async (req) => {
    const message = (req.params as any).message as string;
    asked.push(message);
    return answer(message) as any;
  });
  await c.connect(new StreamableHTTPClientTransport(new URL(URL_)));
  const call = async (name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: args })).structuredContent as any;
  return { c, call, asked };
}

test("elicitation: approving in the client executes the refill inside the same tools/call", async () => {
  await resetDemo();
  const { c, call, asked } = await elicitingClient(() => ({ action: "accept", content: { approve: true, answered_by: "Asha (voice)" } }));
  const r = await call("request_refill", { medication: "Amlodipine" });
  assert.equal(asked.length, 1);
  assert.match(asked[0], /refill request for 30 × Amlodipine/);
  assert.equal(r.data.status, "done");
  assert.equal(r.data.confirmed_via, "mcp_elicitation");
  assert.equal(r.data.answered_by, "Asha (voice)");
  assert.equal((await call("get_care_overview")).data.pending_confirmations.length, 0);
  await c.close();
});

test("elicitation: declining cancels and nothing changes", async () => {
  await resetDemo();
  const { c, call } = await elicitingClient(() => ({ action: "accept", content: { approve: false } }));
  const r = await call("cancel_appointment", { appointment_id: "appt_eye" });
  assert.equal(r.data.status, "cancelled");
  const appts = (await call("list_appointments", { days: 30 })).data;
  assert.ok(appts.some((a: any) => a.id === "appt_eye"), "appointment must still exist");
  await c.close();
});

test("agent relays the server's question to the device and the answer back", async () => {
  await resetDemo();
  const res = await fetch(`${BASE}/api/agent/chat`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ elicitation: true, history: [{ role: "user", text: "I'm running low on my blood pressure pills, please order a refill" }] }) });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const events: any[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const e = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      events.push(e);
      if (e.type === "elicit")
        await fetch(`${BASE}/api/agent/elicit/${e.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ approve: true }) });
    }
  }
  assert.ok(events.some((e) => e.type === "elicit"), "device must be asked");
  const result = events.find((e) => e.type === "tool_result" && e.name === "request_refill").result;
  assert.equal(result.data.status, "done");
  assert.match(events.at(-1).text, /^Done/);
});
