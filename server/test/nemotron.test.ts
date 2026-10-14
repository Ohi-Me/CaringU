// Nemotron-on-Token-Factory agent against a MOCK OpenAI-compatible server (no real key needed).
// Verifies the integration mechanics; real model behaviour is evaluated separately.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import express from "express";
import type { Server } from "node:http";

const MOCK_PORT = 8810, OK_PORT = 8811, BADKEY_PORT = 8812;
const KEY = "test-key-should-never-leak-123";
const calls: { model: string; last: string }[] = [];
let mock: Server;
const procs: ChildProcess[] = [];

function toolCall(name: string, args: string, id = "call_1") {
  return { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name, arguments: args } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
}
const answer = (content: string) => ({ choices: [{ finish_reason: "stop", message: { role: "assistant", content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });

before(async () => {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use((req, res, next) => (req.headers.authorization === `Bearer ${KEY}` ? next() : res.status(401).json({ error: "invalid api key" })));
  app.get("/v1/models", (_req, res) => res.json({ data: [{ id: "mock/nemotron-fast" }, { id: "mock/nemotron-ultra" }] }));
  app.post("/v1/chat/completions", (req, res) => {
    const msgs = req.body.messages as any[];
    const last = msgs[msgs.length - 1];
    const firstUser = [...msgs].reverse().find((m) => m.role === "user")?.content ?? "";
    calls.push({ model: req.body.model, last: last.role });
    assert.ok(Array.isArray(req.body.tools) && req.body.tools.length > 20, "MCP tools must be offered as functions");
    if (/FAIL_AFTER_WRITE/.test(firstUser)) {
      if (last.role === "user") return res.json(toolCall("notify_family", JSON.stringify({ message: "Asha asked for a call", severity: "info" })));
      return res.status(500).json({ error: "upstream exploded" });
    }
    if (last.role === "tool") return res.json(answer(`<think>check the record first</think>Done, based on the tool result: ${String(last.content).slice(0, 40)}`));
    if (/BAD_JSON/.test(firstUser)) return res.json(toolCall("list_medications", "{not json"));
    if (/BP pill/i.test(firstUser)) return res.json(toolCall("check_dose_status", JSON.stringify({ medication: "bp" })));
    return res.json(answer("<think>easy</think>Hello, I'm CareCircle."));
  });
  await new Promise<void>((r) => { mock = app.listen(MOCK_PORT, () => r()); });

  const env = (port: number, key: string) => ({ ...process.env, PORT: String(port), DB_PATH: ":memory:", WEB_DIST: "__none__",
    AGENT_MODE: "nebius", NEBIUS_API_KEY: key, NEBIUS_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
    NEBIUS_MODEL_FAST: "mock/nemotron-fast", NEBIUS_MODEL_REASON: "mock/nemotron-ultra", NEBIUS_MODEL_VISION: "mock/nemotron-omni" });
  for (const [port, key] of [[OK_PORT, KEY], [BADKEY_PORT, "wrong-key"]] as const)
    procs.push(spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { env: env(port, key), stdio: "ignore" }));
  for (const port of [OK_PORT, BADKEY_PORT]) {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    await fetch(`http://127.0.0.1:${port}/api/reset`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ time: "10:00" }) });
  }
});
after(() => { procs.forEach((p) => p.kill()); mock?.close(); });

async function chat(port: number, text: string, speaker = "Asha (voice)") {
  const r = await fetch(`http://127.0.0.1:${port}/api/agent/chat`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ history: [{ role: "user", text }], speaker }) });
  const raw = await r.text();
  const ev = raw.trim().split("\n").map((l) => JSON.parse(l));
  return { raw, ev, final: ev.find((e) => e.type === "final") };
}

test("mode endpoint: Nebius configured, key works, models checked against /models", async () => {
  const m = await (await fetch(`http://127.0.0.1:${OK_PORT}/api/agent/mode`)).json();
  assert.equal(m.configured, "nebius");
  assert.equal(m.effective, "nebius");
  assert.deepEqual(m.credentials.models, { fast: true, reason: true, vision: false });
});

test("Nemotron calls MCP tools; reasoning traces are not spoken", async () => {
  const r = await chat(OK_PORT, "Did I take my BP pill?");
  assert.ok(r.ev.some((e) => e.type === "tool_call" && e.name === "check_dose_status"));
  assert.ok(r.ev.some((e) => e.type === "tool_result" && e.name === "check_dose_status" && e.ok));
  assert.equal(r.final.mode, "nebius");
  assert.equal(r.final.model, "mock/nemotron-fast");
  assert.match(r.final.text, /^Done, based on the tool result/);
  assert.doesNotMatch(r.final.text, /think/);
});

test("routing: caregiver weekly review goes to the reasoning model", async () => {
  calls.length = 0;
  const r = await chat(OK_PORT, "How has mom been this week? Anything I should worry about?", "Ravi (son)");
  assert.ok(r.ev.some((e) => e.type === "route" && e.model === "mock/nemotron-ultra"));
  assert.ok(calls.every((c) => c.model === "mock/nemotron-ultra"));
  assert.equal(r.final.model, "mock/nemotron-ultra");
});

test("invalid tool-argument JSON is returned to the model as an error, not executed", async () => {
  const r = await chat(OK_PORT, "BAD_JSON please list my medicines");
  assert.ok(!r.ev.some((e) => e.type === "tool_call" && e.name === "list_medications"), "nothing should run with bad args");
  assert.equal(r.final.mode, "nebius");
});

test("wrong key: honest fallback to rules, key never leaks", async () => {
  const m = await (await fetch(`http://127.0.0.1:${BADKEY_PORT}/api/agent/mode`)).json();
  assert.equal(m.effective, "rules");
  const r = await chat(BADKEY_PORT, "Hello! Introduce yourself.");
  assert.equal(r.final.mode, "rules");
  assert.equal(r.final.fallback.from, "nebius");
  assert.match(r.final.fallback.reason, /401/);
  assert.ok(!r.raw.includes(KEY) && !r.raw.includes("wrong-key"));
});

test("failure after a state change: no fallback that could repeat it", async () => {
  const r = await chat(OK_PORT, "FAIL_AFTER_WRITE tell Ravi to call me");
  assert.equal(r.final.mode, "nebius-partial");
  assert.match(r.final.text, /notify family/);
  assert.ok(!r.raw.includes(KEY));
});

test("safety screen still owns emergencies under Nemotron", async () => {
  calls.length = 0;
  const r = await chat(OK_PORT, "My face is drooping and my words are coming out wrong");
  assert.equal(r.final.mode, "safety-screen");
  assert.match(r.final.text, /112/);
  assert.equal(calls.length, 0, "no model call needed for a red-flag emergency");
});
