// The agent: a real MCP *client* (Streamable HTTP) driven either by Amazon Bedrock
// (Converse API with tool use) or, when no AWS credentials are configured, by a
// transparent rule-based planner. Every step is streamed to the browser as NDJSON.
import { Router } from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { BedrockRuntimeClient, ConverseCommand, type Message, type Tool } from "@aws-sdk/client-bedrock-runtime";
import { ruleAgent } from "./ruleAgent.js";
import type { Clock } from "./care.js";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Emit = (e: Record<string, unknown>) => void;
export type Turn = { role: "user" | "assistant"; text: string };
export type CallTool = (name: string, args: Record<string, unknown>) => Promise<any>;

const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? "us.amazon.nova-pro-v1:0";
const REGION = process.env.AWS_REGION ?? "us-east-1";
const MAX_STEPS = 8;

export function systemPrompt(now: Date, speaker: string) {
  return `You are CareCircle, a warm, patient voice assistant (Alexa+-style) for Asha Mehra, 78, and her family caregivers.
Current local time: ${now.toString()}. Current speaker: ${speaker}.
Rules:
- Facts come ONLY from tool results. Never guess whether a dose was taken; call check_dose_status or get_care_overview.
- Before recording a dose use record_dose; if it returns DOUBLE_DOSE_RISK, clearly tell the user NOT to take another and that family was told.
- request_refill, schedule_appointment and cancel_appointment only PROPOSE. Read the summary and ask "Shall I go ahead?". Call confirm_action only after an explicit yes in the user's latest message. Never claim something was done unless a tool result says so.
- Symptoms: call log_wellbeing. For red flags, tell them to call emergency services (112 India / 911 US) now. Never diagnose or change medication.
- If someone describes a call/message asking for money, codes, PINs or app installs, call assess_scam_risk.
- If transport for an appointment is "NOT ARRANGED", offer to message the family.
- Use real ids from tool results only. If a request is ambiguous (e.g. which medicine), ask one short question.
- Replies are spoken aloud: 1-3 short sentences, plain words, no markdown, no lists, no ids.`;
}

async function connectMcp(url: string, emit: Emit) {
  const client = new Client({ name: "carecircle-agent", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const t0 = performance.now();
  await client.connect(transport); // sends initialize + notifications/initialized
  emit({ type: "mcp", method: "initialize", protocolVersion: transport.protocolVersion, server: client.getServerVersion()?.name, ms: Math.round(performance.now() - t0) });
  const t1 = performance.now();
  const { tools } = await client.listTools();
  emit({ type: "mcp", method: "tools/list", count: tools.length, ms: Math.round(performance.now() - t1) });
  const call: CallTool = async (name, args) => {
    emit({ type: "tool_call", name, args });
    const t = performance.now();
    try {
      const r: any = await client.callTool({ name, arguments: args });
      const payload = r.structuredContent ?? JSON.parse(r.content?.[0]?.text ?? "{}");
      emit({ type: "tool_result", name, ok: !r.isError, ms: Math.round(performance.now() - t), result: payload });
      return payload;
    } catch (e: any) {
      const payload = { ok: false, error: { code: "MCP_ERROR", message: String(e?.message ?? e), retryable: true } };
      emit({ type: "tool_result", name, ok: false, ms: Math.round(performance.now() - t), result: payload });
      return payload;
    }
  };
  return { client, tools, call };
}

export function bedrockConfigured() {
  if (process.env.AGENT_MODE === "rules") return false;
  return !!(process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE || process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
    || process.env.AWS_WEB_IDENTITY_TOKEN_FILE || process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI || process.env.AGENT_MODE === "bedrock"
    || existsSync(join(homedir(), ".aws", "credentials")));
}

async function bedrockAgent(history: Turn[], speaker: string, tools: any[], call: CallTool, emit: Emit, now: Date) {
  const br = new BedrockRuntimeClient({ region: REGION });
  const toolConfig = {
    tools: tools.map((t) => ({ toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.inputSchema } } })) as Tool[],
  };
  const messages: Message[] = history.slice(-12).map((t) => ({ role: t.role, content: [{ text: t.text }] }));
  while (messages.length && messages[0].role !== "user") messages.shift();
  for (let step = 0; step < MAX_STEPS; step++) {
    const t0 = performance.now();
    const out = await br.send(new ConverseCommand({
      modelId: MODEL_ID, system: [{ text: systemPrompt(now, speaker) }], messages, toolConfig,
      inferenceConfig: { maxTokens: 700, temperature: 0.2 },
    }));
    emit({ type: "model", provider: "bedrock", model: MODEL_ID, step, ms: Math.round(performance.now() - t0), usage: out.usage, stop: out.stopReason });
    const msg = out.output?.message;
    if (!msg) throw new Error("Empty Bedrock response");
    messages.push(msg);
    const uses = (msg.content ?? []).filter((c) => c.toolUse);
    if (out.stopReason !== "tool_use" || !uses.length)
      return (msg.content ?? []).map((c) => c.text ?? "").join(" ").replace(/<thinking>[\s\S]*?<\/thinking>/g, "").trim();
    const results = [];
    for (const u of uses) {
      const r = await call(u.toolUse!.name!, (u.toolUse!.input ?? {}) as Record<string, unknown>);
      results.push({ toolResult: { toolUseId: u.toolUse!.toolUseId!, content: [{ json: r }], status: (r?.ok === false ? "error" : "success") as "error" | "success" } });
    }
    messages.push({ role: "user", content: results });
  }
  return "Sorry, that took too many steps. Please try a simpler request.";
}

export function agentRouter(mcpUrl: string, clock: Clock) {
  const r = Router();
  r.get("/mode", (_req, res) => res.json({ mode: bedrockConfigured() ? "bedrock" : "rules", model: bedrockConfigured() ? MODEL_ID : null }));
  r.post("/chat", async (req, res) => {
    const history: Turn[] = Array.isArray(req.body?.history) ? req.body.history.filter((t: any) => typeof t?.text === "string").slice(-20) : [];
    const speaker = typeof req.body?.speaker === "string" ? req.body.speaker.slice(0, 60) : "Asha (voice)";
    if (!history.length || history[history.length - 1].role !== "user") return res.status(400).json({ error: "history must end with a user turn" });
    res.setHeader("Content-Type", "application/x-ndjson");
    const emit: Emit = (e) => res.write(JSON.stringify(e) + "\n");
    const t0 = performance.now();
    let mcp: Awaited<ReturnType<typeof connectMcp>> | undefined;
    try {
      mcp = await connectMcp(mcpUrl, emit);
      let text: string, mode = bedrockConfigured() ? "bedrock" : "rules";
      if (mode === "bedrock") {
        try { text = await bedrockAgent(history, speaker, mcp.tools, mcp.call, emit, clock()); }
        catch (e: any) {
          // Honest degradation: say the model failed, then use the deterministic planner.
          emit({ type: "warning", message: `Bedrock unavailable (${e?.name ?? "error"}: ${String(e?.message ?? e).slice(0, 160)}). Falling back to rule-based planner.` });
          mode = "rules";
          text = await ruleAgent(history, speaker, mcp.call, clock());
        }
      } else text = await ruleAgent(history, speaker, mcp.call, clock());
      emit({ type: "final", text, mode, total_ms: Math.round(performance.now() - t0) });
    } catch (e: any) {
      emit({ type: "error", message: `Could not reach the CareCircle MCP server: ${e?.message ?? e}` });
    } finally {
      await mcp?.client.close().catch(() => {});
      res.end();
    }
  });
  return r;
}
