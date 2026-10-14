// NVIDIA Nemotron on Nebius Token Factory (OpenAI-compatible chat completions with tools).
// Model routing: a fast Nemotron model for everyday turns, Nemotron 3 Ultra for the
// heavier caregiver reasoning (weekly care review). The deterministic safety screen
// and confirmation guard in agent.ts wrap this exactly as they wrap Bedrock.
import type { CallTool, Emit, Turn } from "./agent.js";
import type { ScreenOutcome } from "./screen.js";

export const NEBIUS = {
  base: (process.env.NEBIUS_BASE_URL ?? "https://api.tokenfactory.nebius.com/v1").replace(/\/$/, ""),
  // Model ids are configurable because availability differs per account; /api/agent/mode checks them against /models.
  fast: process.env.NEBIUS_MODEL_FAST ?? "nvidia/nemotron-3-super-120b-a12b",
  reason: process.env.NEBIUS_MODEL_REASON ?? "nvidia/nemotron-3-ultra-550b-a55b",
  vision: process.env.NEBIUS_MODEL_VISION ?? "nvidia/nemotron-3-nano-omni",
};
const key = () => process.env.NEBIUS_API_KEY?.trim() || "";
const MAX_STEPS = 8;

export const nebiusConfigured = () => process.env.AGENT_MODE === "nebius" && key().length > 0;

export class ProviderError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = `NebiusHTTP${status}`; }
}

/** Never let the API key appear in any message we log, stream or store. */
const scrub = (s: string) => (key() ? s.split(key()).join("[redacted]") : s);

async function post(path: string, body: unknown, timeoutMs = 60_000): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${NEBIUS.base}${path}`, {
      method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key()}` },
    });
  } catch (e: any) {
    throw new ProviderError(0, scrub(`Token Factory unreachable: ${e?.name ?? "error"}`));
  }
  const text = await res.text();
  if (!res.ok) throw new ProviderError(res.status, scrub(`Token Factory ${res.status}: ${text.slice(0, 200)}`));
  return JSON.parse(text);
}

/** Key works + which configured models the account can see (cached; no model call). */
let statusCache: { at: number; value: any } | null = null;
export async function nebiusStatus() {
  if (statusCache && Date.now() - statusCache.at < 60_000) return statusCache.value;
  let value: any;
  if (!key()) value = { ok: false, error: "NEBIUS_API_KEY is not set" };
  else {
    try {
      const res = await fetch(`${NEBIUS.base}/models`, { headers: { Authorization: `Bearer ${key()}` }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) value = { ok: false, error: `models endpoint ${res.status}` };
      else {
        const ids = new Set(((await res.json())?.data ?? []).map((m: any) => m.id));
        value = { ok: true, models: { fast: ids.has(NEBIUS.fast), reason: ids.has(NEBIUS.reason), vision: ids.has(NEBIUS.vision) },
          nemotron_available: [...ids].filter((i: any) => /nemotron/i.test(i)).slice(0, 12) };
      }
    } catch (e: any) {
      value = { ok: false, error: scrub(`${e?.name ?? "Error"}: ${e?.message ?? e}`) };
    }
  }
  statusCache = { at: Date.now(), value };
  return value;
}

/** Fast model for everyday turns; Ultra when a caregiver asks for an overall review or pattern. */
export function routeModel(lastUser: string, speaker: string) {
  const caregiver = !/^asha/i.test(speaker);
  if (caregiver && /\b(week|weekly|review|pattern|trend|worr(y|ied)|overall|how (is|has) (mom|mum|maa|she) been|care plan)\b/i.test(lastUser))
    return { model: NEBIUS.reason, why: "caregiver review needs multi-step reasoning over a week of records (Nemotron 3 Ultra)" };
  return { model: NEBIUS.fast, why: "everyday turn: fast tool-calling model" };
}

/** Reasoning models may emit <think>…</think>; only the answer is spoken. */
export const stripThinking = (s: string) => s.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^[\s\S]*<\/think>/i, "").trim();

/**
 * Tool-calling loop. Tracks state-changing tool calls; if the provider fails after one,
 * the error carries `writes` so the caller won't let a fallback planner repeat them.
 */
export async function nemotronAgent(history: Turn[], speaker: string, tools: any[], rawCall: CallTool, emit: Emit,
  systemText: string, screen: ScreenOutcome): Promise<{ text: string; model: string }> {
  const lastUser = history[history.length - 1].text;
  const route = routeModel(lastUser, speaker);
  emit({ type: "route", provider: "nebius", model: route.model, why: route.why });
  const readOnly = new Set(tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name));
  const writes: { name: string }[] = [];
  const oaTools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
  const notes = screen.notes.length ? `\nSAFETY SCREEN (already executed for the latest message):\n- ${screen.notes.join("\n- ")}` : "";
  const messages: any[] = [{ role: "system", content: systemText + notes }, ...history.slice(-12).map((t) => ({ role: t.role, content: t.text }))];
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const t0 = performance.now();
      const out = await post("/chat/completions", { model: route.model, messages, tools: oaTools, tool_choice: "auto", temperature: 0.2, max_tokens: 800 });
      const choice = out.choices?.[0];
      const msg = choice?.message;
      emit({ type: "model", provider: "nebius", model: route.model, step, ms: Math.round(performance.now() - t0), usage: out.usage, stop: choice?.finish_reason });
      if (!msg) throw new ProviderError(502, "Token Factory returned no message");
      const calls = msg.tool_calls ?? [];
      if (!calls.length) return { text: stripThinking(msg.content ?? ""), model: route.model };
      messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: calls });
      for (const c of calls) {
        let args: Record<string, unknown> = {};
        let result: any;
        try { args = JSON.parse(c.function?.arguments || "{}"); }
        catch { result = { ok: false, error: { code: "BAD_TOOL_ARGUMENTS", message: "Arguments were not valid JSON; call the tool again with a JSON object." } }; }
        if (!result) {
          result = await rawCall(c.function.name, args);
          if (!readOnly.has(c.function.name) && result?.ok !== false) writes.push({ name: c.function.name });
        }
        messages.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(result) });
      }
    }
    return { text: "Sorry, that took too many steps. Please try a simpler request.", model: route.model };
  } catch (e: any) {
    if (writes.length) Object.assign(e, { writes, cause: e });
    throw e;
  }
}
