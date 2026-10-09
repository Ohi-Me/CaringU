// Browser-side MCP client: the family dashboard reads and writes CareCircle state
// through real MCP initialize / tools/list / tools/call over Streamable HTTP.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export type TraceEvent = { at: number; source: "dashboard" | "agent"; kind: string; label: string; ok?: boolean; ms?: number; detail?: unknown };
type Listener = (e: TraceEvent) => void;

let client: Client | null = null;
let connecting: Promise<Client> | null = null;
const listeners = new Set<Listener>();
export const onTrace = (l: Listener) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const trace = (e: Omit<TraceEvent, "at">) => listeners.forEach((l) => l({ ...e, at: Date.now() }));

export let toolNames: string[] = [];

async function connect() {
  const c = new Client({ name: "carecircle-dashboard", version: "0.1.0" });
  const t = new StreamableHTTPClientTransport(new URL("/mcp", location.origin));
  let t0 = performance.now();
  await c.connect(t);
  trace({ source: "dashboard", kind: "mcp", label: `initialize → protocol ${t.protocolVersion}`, ok: true, ms: Math.round(performance.now() - t0) });
  t0 = performance.now();
  const { tools } = await c.listTools();
  toolNames = tools.map((x) => x.name);
  trace({ source: "dashboard", kind: "mcp", label: `tools/list → ${tools.length} tools`, ok: true, ms: Math.round(performance.now() - t0), detail: toolNames });
  return c;
}

export async function callTool<T = any>(name: string, args: Record<string, unknown> = {}, quiet = false): Promise<{ ok: true; data: T } | { ok: false; error: { code: string; message: string } }> {
  if (!client) { connecting ??= connect(); try { client = await connecting; } finally { connecting = null; } }
  const t0 = performance.now();
  try {
    const r: any = await client.callTool({ name, arguments: args });
    const payload = r.structuredContent ?? JSON.parse(r.content?.[0]?.text ?? "{}");
    if (!quiet || !payload.ok) trace({ source: "dashboard", kind: "tools/call", label: name, ok: payload.ok, ms: Math.round(performance.now() - t0), detail: { args, result: payload } });
    return payload;
  } catch (e: any) {
    client = null;
    trace({ source: "dashboard", kind: "tools/call", label: `${name} (transport error)`, ok: false, detail: String(e?.message ?? e) });
    return { ok: false, error: { code: "MCP_ERROR", message: String(e?.message ?? e) } };
  }
}
