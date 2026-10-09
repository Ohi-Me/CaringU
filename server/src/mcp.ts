// MCP server definition: every CareCircle capability is a small, validated MCP tool.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as care from "./care.js";
import type { DB } from "./db.js";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Local date YYYY-MM-DD; omit for today");
const actor = z.string().min(1).max(60).optional().describe("Who is speaking, e.g. 'Asha (voice)' or 'Ravi (son)'");

export function buildMcpServer(db: DB, clock: care.Clock) {
  const server = new McpServer(
    { name: "carecircle", title: "CareCircle", version: "0.1.0" },
    { instructions: "Tools for a voice assistant that helps an older adult manage medicines, appointments and wellbeing while keeping family caregivers informed. All data is sample/demo data. Never diagnose; red-flag symptoms must be escalated. Consequential actions return a confirmation_id and only happen after confirm_action." },
  );

  // Wraps a handler: validates via zod (done by the SDK), times it, writes an audit
  // row, and maps domain errors to a structured isError result.
  function tool<S extends z.ZodRawShape>(
    name: string, cfg: { title: string; description: string; input: S; readOnly?: boolean; destructive?: boolean },
    fn: (args: z.infer<z.ZodObject<S>>, now: Date) => unknown,
  ) {
    server.registerTool(name, {
      title: cfg.title, description: cfg.description, inputSchema: cfg.input,
      annotations: { readOnlyHint: !!cfg.readOnly, destructiveHint: !!cfg.destructive, openWorldHint: false },
    }, (async (args: any) => {
      const t0 = performance.now();
      let ok = true, code: string | null = null, payload: unknown;
      try {
        payload = { ok: true, data: fn(args, clock()) };
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
      const latency = Math.round((performance.now() - t0) * 100) / 100;
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
    description: "Answers 'did I take my X?'. Returns when the medication was last taken, whether another dose is safe now, and the next scheduled time. Accepts a medication id, name or purpose (e.g. 'BP pill').",
    input: { medication: z.string().min(1).max(80) },
  }, (a, now) => care.doseStatus(db, a.medication, now));

  tool("record_dose", {
    title: "Record a dose taken",
    description: "Record that the user just took a medication. Has a built-in double-dose guard: if the previous dose was too recent it refuses with DOUBLE_DOSE_RISK and alerts family. Decrements pill count and warns when supply is low.",
    input: { medication: z.string().min(1).max(80), recorded_by: actor, note: z.string().max(200).optional() },
  }, (a, now) => care.recordDose(db, a.medication, a.recorded_by ?? "Asha (voice)", now, a.note));

  tool("forecast_refills", {
    title: "Forecast refills", readOnly: true,
    description: "For each medication: days of supply left, the date it runs out, and whether it needs a refill within the horizon.",
    input: { horizon_days: z.number().int().min(1).max(60).optional() },
  }, (a, now) => care.forecastRefills(db, now, a.horizon_days ?? 7));

  tool("request_refill", {
    title: "Request a refill (needs confirmation)",
    description: "PROPOSES a pharmacy refill request. Nothing is sent until confirm_action is called with the returned confirmation_id after the user says yes. No payment is ever made.",
    input: { medication: z.string().min(1).max(80), quantity: z.number().int().min(1).max(180).optional() },
  }, (a, now) => care.proposeRefill(db, now, a.medication, a.quantity));

  tool("list_appointments", {
    title: "List appointments", readOnly: true,
    description: "Upcoming scheduled appointments, including whether transport is arranged.",
    input: { from: date.optional(), days: z.number().int().min(1).max(60).optional() },
  }, (a, now) => care.listAppointments(db, now, a.from, a.days ?? 14));

  tool("schedule_appointment", {
    title: "Schedule appointment (needs confirmation)",
    description: "PROPOSES adding an appointment and reports clashes within 2 hours. Saved only after confirm_action.",
    input: {
      title: z.string().min(2).max(120), starts_at: z.string().describe("Local 'YYYY-MM-DD HH:MM'"),
      location: z.string().max(120).optional(), with_whom: z.string().max(80).optional(),
      transport: z.string().max(120).optional(), notes: z.string().max(300).optional(),
    },
  }, (a, now) => care.proposeAppointment(db, now, a));

  tool("cancel_appointment", {
    title: "Cancel appointment (needs confirmation)", destructive: true,
    description: "PROPOSES cancelling an appointment by its real id (from list_appointments). Cancelled only after confirm_action.",
    input: { appointment_id: z.string().min(3).max(40) },
  }, (a, now) => care.proposeCancelAppointment(db, now, a.appointment_id));

  tool("confirm_action", {
    title: "Confirm or cancel a pending action",
    description: "Executes (approve=true) or cancels (approve=false) an action previously proposed. Call ONLY after the user explicitly agreed. Idempotent: a second call reports ALREADY_RESOLVED.",
    input: { confirmation_id: z.string().min(3).max(40), approve: z.boolean(), confirmed_by: actor },
  }, (a, now) => care.resolvePending(db, now, a.confirmation_id, a.approve, a.confirmed_by ?? "Asha (voice)"));

  tool("log_wellbeing", {
    title: "Log how I feel",
    description: "Log mood and symptoms. Red-flag symptoms (chest pain, breathing trouble, fall, fainting, stroke signs, confusion, bleeding) create an URGENT family alert and return emergency guidance. Never diagnose.",
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
  }, (a) => care.listAlerts(db, !!a.include_acknowledged));

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
