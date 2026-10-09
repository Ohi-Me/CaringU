// MCP server definition: every CareCircle capability is a small, validated MCP tool.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as care from "./care.js";
import type { DB } from "./db.js";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Local date YYYY-MM-DD; omit for today");
const actor = z.string().min(1).max(60).optional().describe("Who is speaking, e.g. 'Asha (voice)' or 'Ravi (son)'");

type Confirmation =
  | { asked: false }
  | { asked: true; outcome: "approved" | "declined" | "no_answer"; by: string | null };

interface Ctx { confirm: (message: string) => Promise<Confirmation> }

export function buildMcpServer(db: DB, clock: care.Clock) {
  const server = new McpServer(
    { name: "carecircle", title: "CareCircle", version: "0.2.0" },
    { instructions: "Tools for a voice assistant that helps an older adult manage medicines, appointments and wellbeing while keeping family caregivers informed. All data is sample/demo data. Never diagnose; red-flag symptoms must be escalated. Consequential actions (refills, appointment changes) ask the human directly through MCP elicitation when the client supports it; otherwise they return a confirmation_id and only happen after confirm_action." },
  );

  /**
   * Asks the human to approve an action via MCP elicitation (elicitation/create,
   * form mode). The request travels on the SSE stream of the in-flight tools/call,
   * so it reaches whoever is driving this session (her device or the dashboard),
   * never the language model. Returns asked=false if the client can't elicit.
   */
  async function confirmWithHuman(extra: any, message: string): Promise<Confirmation> {
    if (!server.server.getClientCapabilities()?.elicitation?.form) return { asked: false };
    try {
      const r = await server.server.elicitInput({
        mode: "form", message,
        requestedSchema: {
          type: "object",
          properties: {
            approve: { type: "boolean", title: "Approve", description: message },
            answered_by: { type: "string", title: "Who is answering", description: "Name of the person approving or declining" },
          },
          required: ["approve"],
        },
      }, { relatedRequestId: extra.requestId, timeout: 120_000 });
      const by = typeof r.content?.answered_by === "string" ? r.content.answered_by.slice(0, 60) : null;
      if (r.action === "accept") return { asked: true, outcome: r.content?.approve === true ? "approved" : "declined", by };
      return { asked: true, outcome: r.action === "decline" ? "declined" : "no_answer", by };
    } catch {
      return { asked: true, outcome: "no_answer", by: null }; // timeout or client gone: do nothing
    }
  }

  /** Proposal -> human decision via elicitation -> executed or cancelled, all inside one tools/call. */
  async function withConfirmation(ctx: Ctx, proposal: { confirmation_id: string; summary: string; status: string }) {
    const c = await ctx.confirm(proposal.summary.replace(/\.$/, "") + "?");
    if (!c.asked) return proposal; // client can't elicit: two-phase confirm_action flow
    if (c.outcome === "no_answer")
      return { ...proposal, confirmed_via: "mcp_elicitation", elicitation: "no_answer", next_step: "Nobody answered. Nothing was done; the request is still pending and can be approved later." };
    const done = care.resolvePending(db, clock(), proposal.confirmation_id, c.outcome === "approved", c.by ?? "user (via device)");
    return { ...done, confirmed_via: "mcp_elicitation", answered_by: c.by };
  }

  // Wraps a handler: validates via zod (done by the SDK), times it (excluding time
  // spent waiting for a human), writes an audit row, and maps domain errors to a
  // structured isError result.
  function tool<S extends z.ZodRawShape>(
    name: string, cfg: { title: string; description: string; input: S; readOnly?: boolean; destructive?: boolean },
    fn: (args: z.infer<z.ZodObject<S>>, now: Date, ctx: Ctx) => unknown,
  ) {
    server.registerTool(name, {
      title: cfg.title, description: cfg.description, inputSchema: cfg.input,
      annotations: { readOnlyHint: !!cfg.readOnly, destructiveHint: !!cfg.destructive, openWorldHint: false },
    }, (async (args: any, extra: any) => {
      const t0 = performance.now();
      let humanMs = 0;
      const ctx: Ctx = {
        confirm: async (message) => {
          const h = performance.now();
          try { return await confirmWithHuman(extra, message); } finally { humanMs += performance.now() - h; }
        },
      };
      let ok = true, code: string | null = null, payload: unknown;
      try {
        payload = { ok: true, data: await fn(args, clock(), ctx) };
      } catch (e) {
        ok = false;
        if (e instanceof care.ToolError) {
          code = e.code;
          payload = { ok: false, error: { code: e.code, message: e.message, retryable: e.retryable, details: e.details } };
        } else {
          code = "INTERNAL";
          console.error(`[tool ${name}]`, e);
          payload = { ok: false, error: { code: "INTERNAL", message: "Internal error; nothing may have been saved.", retryable: true } };
        }
      }
      const latency = Math.round((performance.now() - t0 - humanMs) * 100) / 100;
      db.prepare("INSERT INTO audit (at, tool, args, ok, code, latency_ms) VALUES (?,?,?,?,?,?)")
        .run(clock().toISOString(), name, JSON.stringify(redact(args)), ok ? 1 : 0, code, latency);
      return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload as Record<string, unknown>, isError: !ok };
    }) as any);
  }

  tool("get_care_overview", {
    title: "Today's care overview", readOnly: true,
    description: "Start here. Today's medication schedule (taken / due_now / missed / upcoming), appointments, open family alerts and actions awaiting confirmation.",
    input: { date: date.optional() },
  }, (a, now) => care.careOverview(db, now, a.date));

  tool("list_medications", {
    title: "List medications", readOnly: true,
    description: "All active medications with dose, purpose, scheduled times, minimum safe gap between doses and pills left.",
    input: {},
  }, () => care.listMedications(db));

  tool("check_dose_status", {
    title: "Did I take it?", readOnly: true,
    description: "Answers 'did I take my X?' / 'should I take X?'. Returns what is RECORDED (last record, whether a dose is recorded within the minimum gap, today's slots) and the next scheduled time. It never certifies a dose as safe: records only include reported doses. Accepts a medication id, name or purpose (e.g. 'BP pill').",
    input: { medication: z.string().min(1).max(80) },
  }, (a, now) => care.doseStatus(db, a.medication, now));

  tool("record_dose", {
    title: "Record a dose taken",
    description: "Record that the user took a medication (now, or at taken_at). If another dose is already recorded within the minimum gap it records NOTHING and returns status=possible_duplicate with a question to ask; only if the user says they really took another one, call again with extra_dose_confirmed=true, which records it, raises an URGENT family alert and returns guidance. Same dose reported twice returns already_recorded. Decrements pill count and warns when supply is low.",
    input: {
      medication: z.string().min(1).max(80), recorded_by: actor,
      taken_at: z.string().max(20).optional().describe("When it was taken: 'HH:MM' today or 'YYYY-MM-DD HH:MM'; omit for now"),
      extra_dose_confirmed: z.boolean().optional().describe("true ONLY after the user confirmed they took an additional dose"),
      note: z.string().max(200).optional(),
    },
  }, (a, now) => care.recordDose(db, a.medication, a.recorded_by ?? "Asha (voice)", now, { taken_at: a.taken_at, extra_dose_confirmed: a.extra_dose_confirmed, note: a.note }));

  tool("forecast_refills", {
    title: "Forecast refills", readOnly: true,
    description: "For each medication: days of supply left, the date it runs out, and whether it needs a refill within the horizon.",
    input: { horizon_days: z.number().int().min(1).max(60).optional() },
  }, (a, now) => care.forecastRefills(db, now, a.horizon_days ?? 7));

  tool("request_refill", {
    title: "Request a refill (needs confirmation)",
    description: "Requests a pharmacy refill, gated on human approval. If the client supports MCP elicitation the server asks the person directly and returns the final status (done / cancelled / no answer). Otherwise it returns status=awaiting_confirmation and a confirmation_id for confirm_action after the user says yes. No payment is ever made.",
    input: { medication: z.string().min(1).max(80), quantity: z.number().int().min(1).max(180).optional() },
  }, (a, now, ctx) => withConfirmation(ctx, care.proposeRefill(db, now, a.medication, a.quantity)));

  tool("list_appointments", {
    title: "List appointments", readOnly: true,
    description: "Upcoming scheduled appointments, including whether transport is arranged.",
    input: { from: date.optional(), days: z.number().int().min(1).max(60).optional() },
  }, (a, now) => care.listAppointments(db, now, a.from, a.days ?? 14));

  tool("schedule_appointment", {
    title: "Schedule appointment (needs confirmation)",
    description: "Adds an appointment after human approval (MCP elicitation, or confirmation_id + confirm_action for clients without elicitation). Reports clashes within 2 hours.",
    input: {
      title: z.string().min(2).max(120), starts_at: z.string().describe("Local 'YYYY-MM-DD HH:MM'"),
      location: z.string().max(120).optional(), with_whom: z.string().max(80).optional(),
      transport: z.string().max(120).optional(), notes: z.string().max(300).optional(),
    },
  }, async (a, now, ctx) => {
    const p = care.proposeAppointment(db, now, a);
    return { ...(await withConfirmation(ctx, p)), conflicts_within_2h: (p as any).conflicts_within_2h };
  });

  tool("cancel_appointment", {
    title: "Cancel appointment (needs confirmation)", destructive: true,
    description: "Cancels an appointment by its real id (from list_appointments) after human approval (MCP elicitation, or confirmation_id + confirm_action for clients without elicitation).",
    input: { appointment_id: z.string().min(3).max(40) },
  }, (a, now, ctx) => withConfirmation(ctx, care.proposeCancelAppointment(db, now, a.appointment_id)));

  tool("confirm_action", {
    title: "Confirm or cancel a pending action",
    description: "Executes (approve=true) or cancels (approve=false) an action previously proposed. Call ONLY after the user explicitly agreed. Idempotent: a second call reports ALREADY_RESOLVED.",
    input: { confirmation_id: z.string().min(3).max(40), approve: z.boolean(), confirmed_by: actor },
  }, (a, now) => care.resolvePending(db, now, a.confirmation_id, a.approve, a.confirmed_by ?? "Asha (voice)"));

  tool("log_wellbeing", {
    title: "Log how I feel",
    description: "Log mood and symptoms. Deterministic triage (urgent / watch / routine) with negation handling. Urgent red flags (stroke signs, chest pain, breathing trouble, fainting, serious fall, heavy bleeding, low-sugar confusion) create an URGENT family alert and return say_first, which must open the reply. Never diagnose.",
    input: { symptoms: z.string().min(1).max(500), mood: z.string().max(40).optional() },
  }, (a, now) => care.logWellbeing(db, now, a.mood, a.symptoms));

  tool("assess_scam_risk", {
    title: "Scam guard",
    description: "Checks the content of a phone call, SMS or email the user describes for scam signals (OTP/PIN requests, remote-access apps, gift cards, fake police/bank, urgency, secrecy). Alerts family when suspicious.",
    input: { text: z.string().min(3).max(2000), channel: z.enum(["call", "sms", "email", "whatsapp", "in_person"]).optional() },
  }, (a, now) => care.assessScam(db, now, a.text, a.channel));

  tool("notify_family", {
    title: "Message the family",
    description: "Send a message to the caregivers' CareCircle dashboard (e.g. 'please call me', 'I need a ride tomorrow').",
    input: { message: z.string().min(2).max(500), severity: z.enum(["info", "warning", "urgent"]).optional() },
  }, (a, now) => care.notifyFamily(db, now, a.message, a.severity ?? "info"));

  tool("list_alerts", {
    title: "List family alerts", readOnly: true,
    description: "Open (unacknowledged) caregiver alerts, most severe first.",
    input: { include_acknowledged: z.boolean().optional() },
  }, (a, now) => care.listAlerts(db, !!a.include_acknowledged, now));

  tool("respond_to_alert", {
    title: "Caregiver responds to an alert",
    description: "A caregiver takes responsibility for an alert ('calling_now', 'on_my_way', 'will_call_soon' or 'handled'), optionally with a short message. Stops the escalation ladder and the older adult's device speaks the response to her. Fails with ALREADY_CLAIMED if someone else is handling it.",
    input: {
      alert_id: z.string().min(3).max(40), responder: z.string().min(1).max(60),
      action: z.enum(["calling_now", "on_my_way", "will_call_soon", "handled"]),
      message: z.string().min(1).max(200).optional(),
    },
  }, (a, now) => care.respondToAlert(db, now, a.alert_id, a.responder, a.action, a.message));

  tool("send_message_to_elder", {
    title: "Send a spoken message to her device",
    description: "A caregiver sends a short message that her CareCircle device reads aloud (e.g. 'I'll visit at 6').",
    input: { from: z.string().min(1).max(60), text: z.string().min(1).max(300) },
  }, (a, now) => care.sendMessageToElder(db, now, a.from, a.text));

  tool("get_announcements", {
    title: "Announcements waiting for her device", readOnly: true,
    description: "Messages the older adult's device has not spoken yet (caregiver replies, escalation notices). Also advances the escalation ladder.",
    input: {},
  }, (_a, now) => care.getAnnouncements(db, now));

  tool("mark_announcements_heard", {
    title: "Mark announcements as spoken",
    description: "The device calls this after reading messages aloud.",
    input: { message_ids: z.array(z.string().min(3).max(40)).min(1).max(20) },
  }, (a, now) => care.markAnnouncementsHeard(db, now, a.message_ids));

  tool("acknowledge_alert", {
    title: "Acknowledge alert",
    description: "Caregiver marks an alert as handled.",
    input: { alert_id: z.string().min(3).max(40), acknowledged_by: z.string().min(1).max(60) },
  }, (a, now) => care.acknowledgeAlert(db, now, a.alert_id, a.acknowledged_by));

  tool("get_family_digest", {
    title: "Family daily digest", readOnly: true,
    description: "Daily summary for caregivers: adherence, missed doses, wellbeing entries, alerts, upcoming appointments and refills needed.",
    input: { date: date.optional() },
  }, (a, now) => care.familyDigest(db, now, a.date));

  return server;
}

function redact(args: Record<string, unknown>) {
  // Keep the audit useful without storing free-text health/scam details verbatim.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args ?? {}))
    out[k] = typeof v === "string" && v.length > 60 ? `${v.slice(0, 40)}… (${v.length} chars)` : v;
  return out;
}
