// Domain logic for CareCircle. Deterministic and model-free: the LLM only decides
// WHICH of these to call; every fact and every safety rule lives here.
import { randomUUID } from "node:crypto";
import { type DB, tx } from "./db.js";

export class ToolError extends Error {
  constructor(public code: string, message: string, public retryable = false, public details?: unknown) {
    super(message);
  }
}

export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

type Row = Record<string, any>;
const id = (p: string) => `${p}_${randomUUID().slice(0, 8)}`;
const HOUR = 3_600_000;

// ---------- time helpers (server local time) ----------
export function ymd(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export function localStamp(iso: string) {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${ymd(d)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function slotOn(day: Date, hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(day);
  d.setHours(h, m, 0, 0);
  return d;
}
function parseDay(date: string | undefined, now: Date) {
  if (!date) return new Date(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ToolError("INVALID_DATE", `Expected YYYY-MM-DD, got "${date}"`);
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d, 12);
}

// ---------- medications ----------
function med(r: Row) {
  const times: string[] = JSON.parse(r.times);
  const perDay = times.length * r.pills_per_dose;
  return {
    id: r.id as string, name: r.name as string, dose: r.dose as string, purpose: r.purpose as string | null,
    times, min_gap_hours: r.min_gap_hours as number, pills_left: r.pills_left as number,
    pills_per_dose: r.pills_per_dose as number, with_food: !!r.with_food,
    days_of_supply: perDay ? Math.floor(r.pills_left / perDay) : null,
  };
}

// Everyday words people use for a medicine -> stored purpose.
export const SYNONYMS: [RegExp, string][] = [
  [/\b(bp|blood ?pressure|pressure|hypertension)\b/, "blood pressure"],
  [/\b(sugar|diabet\w*|glucose)\b/, "diabetes"],
  [/\b(thyroid)\b/, "thyroid"],
  [/\b(cholesterol|statin)\b/, "cholesterol"],
];

export function listMedications(db: DB) {
  return db.prepare("SELECT * FROM medications WHERE active = 1 ORDER BY name").all().map(med);
}

export function findMedication(db: DB, ref: string) {
  const all = listMedications(db);
  const exact = all.find((m) => m.id === ref);
  if (exact) return exact;
  let q = ref.trim().toLowerCase().replace(/\b(my|the|pills?|tablets?|medicine|meds?)\b/g, " ").replace(/\s+/g, " ").trim();
  for (const [re, purpose] of SYNONYMS) if (re.test(q)) q = purpose;
  const hits = all.filter((m) => m.name.toLowerCase().includes(q) || (m.purpose ?? "").toLowerCase().includes(q));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1)
    throw new ToolError("AMBIGUOUS_MEDICATION", `"${ref}" matches ${hits.length} medications; ask which one.`, false,
      { candidates: hits.map((m) => ({ id: m.id, name: m.name, purpose: m.purpose })) });
  throw new ToolError("MEDICATION_NOT_FOUND", `No active medication matches "${ref}".`, false,
    { known: all.map((m) => m.name) });
}

function lastDose(db: DB, medId: string) {
  return db.prepare("SELECT * FROM dose_log WHERE medication_id = ? ORDER BY taken_at DESC LIMIT 1").get(medId) as Row | undefined;
}

export function doseStatus(db: DB, ref: string, now: Date) {
  const m = findMedication(db, ref);
  const last = lastDose(db, m.id);
  const hoursSince = last ? (now.getTime() - new Date(last.taken_at).getTime()) / HOUR : null;
  const safe = hoursSince === null || hoursSince >= m.min_gap_hours;
  const next = [0, 1].flatMap((d) => {
    const day = new Date(now.getTime() + d * 24 * HOUR);
    return m.times.map((t) => slotOn(day, t));
  }).find((s) => s.getTime() > now.getTime());
  return {
    medication: { id: m.id, name: m.name, dose: m.dose, purpose: m.purpose, with_food: m.with_food },
    last_taken: last ? localStamp(last.taken_at) : null,
    hours_since_last: hoursSince === null ? null : Math.round(hoursSince * 10) / 10,
    min_gap_hours: m.min_gap_hours,
    safe_to_take_now: safe,
    earliest_safe_time: safe || !last ? null : localStamp(new Date(new Date(last.taken_at).getTime() + m.min_gap_hours * HOUR).toISOString()),
    next_scheduled: next ? localStamp(next.toISOString()) : null,
    pills_left: m.pills_left,
  };
}

export function recordDose(db: DB, ref: string, recordedBy: string, now: Date, note?: string) {
  const m = findMedication(db, ref);
  const st = doseStatus(db, m.id, now);
  if (!st.safe_to_take_now) {
    raiseAlert(db, now, "warning", "double_dose_blocked",
      `Blocked a possible double dose of ${m.name}: last taken ${st.last_taken}, minimum gap ${m.min_gap_hours}h.`);
    throw new ToolError("DOUBLE_DOSE_RISK",
      `${m.name} was already taken at ${st.last_taken} (${st.hours_since_last}h ago). Minimum gap is ${m.min_gap_hours}h. Dose NOT recorded; family has been notified.`,
      false, st);
  }
  if (m.pills_left < m.pills_per_dose)
    throw new ToolError("OUT_OF_STOCK", `No ${m.name} pills left according to the record. Request a refill.`);
  return tx(db, () => {
    const doseId = id("dose");
    db.prepare("INSERT INTO dose_log (id, medication_id, taken_at, recorded_by, note) VALUES (?,?,?,?,?)")
      .run(doseId, m.id, now.toISOString(), recordedBy, note ?? null);
    db.prepare("UPDATE medications SET pills_left = pills_left - pills_per_dose WHERE id = ?").run(m.id);
    const after = findMedication(db, m.id);
    let refill_warning: string | null = null;
    if (after.days_of_supply !== null && after.days_of_supply <= 5) {
      refill_warning = `${after.name}: only ${after.pills_left} pills left (~${after.days_of_supply} days).`;
      const open = db.prepare("SELECT 1 FROM alerts WHERE kind='refill_low' AND message LIKE ? AND acknowledged_at IS NULL")
        .get(`${after.name}:%`);
      if (!open) raiseAlert(db, now, "warning", "refill_low", refill_warning);
    }
    return { dose_id: doseId, medication: after.name, taken_at: localStamp(now.toISOString()), pills_left: after.pills_left, refill_warning };
  });
}

// ---------- daily overview ----------
export function careOverview(db: DB, now: Date, date?: string) {
  const day = parseDay(date, now);
  const dayStart = new Date(day); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart.getTime() + 24 * HOUR);
  const doses = db.prepare("SELECT * FROM dose_log WHERE taken_at >= ? AND taken_at < ?")
    .all(new Date(dayStart.getTime() - 6 * HOUR).toISOString(), new Date(dayEnd.getTime() + 6 * HOUR).toISOString()) as Row[];
  const used = new Set<string>();
  const schedule = listMedications(db).flatMap((m) => m.times.map((t) => {
    const slot = slotOn(day, t);
    // A dose counts for a slot if taken from 3h before to 10h after it (>4h after = late).
    const delta = (d: Row) => new Date(d.taken_at).getTime() - slot.getTime();
    const hit = doses.find((d) => d.medication_id === m.id && !used.has(d.id) && delta(d) >= -3 * HOUR && delta(d) <= 10 * HOUR);
    if (hit) used.add(hit.id);
    const status = hit ? (delta(hit) > 4 * HOUR ? "taken_late" : "taken")
      : now.getTime() > slot.getTime() + 2 * HOUR ? "missed"
      : now.getTime() >= slot.getTime() - HOUR ? "due_now" : "upcoming";
    return { medication_id: m.id, medication: m.name, dose: m.dose, time: t, with_food: m.with_food, status,
      taken_at: hit ? localStamp(hit.taken_at) : null };
  })).sort((a, b) => a.time.localeCompare(b.time));
  return {
    date: ymd(day), now: localStamp(now.toISOString()),
    medication_schedule: schedule,
    counts: {
      taken: schedule.filter((s) => s.status.startsWith("taken")).length,
      missed: schedule.filter((s) => s.status === "missed").length,
      due_now: schedule.filter((s) => s.status === "due_now").length,
      upcoming: schedule.filter((s) => s.status === "upcoming").length,
    },
    appointments: listAppointments(db, now, ymd(day), 1),
    open_alerts: listAlerts(db, false).slice(0, 5),
    pending_confirmations: listPending(db),
  };
}

// ---------- refills ----------
export function forecastRefills(db: DB, now: Date, horizonDays = 7) {
  return listMedications(db).map((m) => {
    const perDay = m.times.length * m.pills_per_dose;
    const days = perDay ? m.pills_left / perDay : Infinity;
    return {
      medication_id: m.id, medication: m.name, pills_left: m.pills_left, doses_per_day: m.times.length,
      days_of_supply: Math.floor(days),
      runs_out_on: Number.isFinite(days) ? ymd(new Date(now.getTime() + days * 24 * HOUR)) : null,
      needs_refill: days <= horizonDays,
    };
  }).sort((a, b) => a.days_of_supply - b.days_of_supply);
}

// ---------- appointments ----------
export function listAppointments(db: DB, now: Date, from?: string, days = 14) {
  const start = parseDay(from, now); start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + days * 24 * HOUR);
  return (db.prepare("SELECT * FROM appointments WHERE status='scheduled' AND starts_at >= ? AND starts_at < ? ORDER BY starts_at")
    .all(start.toISOString(), end.toISOString()) as Row[]).map((a) => ({
      id: a.id, title: a.title, starts_at: localStamp(a.starts_at), location: a.location, with_whom: a.with_whom,
      transport: a.transport ?? "NOT ARRANGED", notes: a.notes,
    }));
}

function parseLocalDateTime(s: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(s);
  if (!m) throw new ToolError("INVALID_DATETIME", `Expected "YYYY-MM-DD HH:MM", got "${s}"`);
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
}

// ---------- confirmation gate ----------
type PendingAction =
  | { action: "request_refill"; payload: { medication_id: string; quantity: number; pharmacy: string } }
  | { action: "schedule_appointment"; payload: { title: string; starts_at: string; location?: string; with_whom?: string; transport?: string; notes?: string } }
  | { action: "cancel_appointment"; payload: { appointment_id: string } };

function propose(db: DB, now: Date, p: PendingAction, summary: string, extra: Record<string, unknown> = {}) {
  const dup = db.prepare("SELECT * FROM pending_actions WHERE status='awaiting_confirmation' AND action=? AND payload=?")
    .get(p.action, JSON.stringify(p.payload)) as Row | undefined;
  const pid = dup?.id ?? id("act");
  if (!dup)
    db.prepare("INSERT INTO pending_actions (id, at, action, payload, summary) VALUES (?,?,?,?,?)")
      .run(pid, now.toISOString(), p.action, JSON.stringify(p.payload), summary);
  return { status: "awaiting_confirmation", confirmation_id: pid, summary, duplicate_of_existing_request: !!dup, ...extra,
    next_step: "Read the summary to the user and call confirm_action only after they explicitly say yes." };
}

export function proposeRefill(db: DB, now: Date, ref: string, quantity?: number, pharmacy = "Sample Pharmacy (simulated)") {
  const m = findMedication(db, ref);
  const qty = quantity ?? m.times.length * m.pills_per_dose * 30;
  if (!Number.isInteger(qty) || qty < 1 || qty > 180) throw new ToolError("INVALID_QUANTITY", "Quantity must be 1-180.");
  return propose(db, now, { action: "request_refill", payload: { medication_id: m.id, quantity: qty, pharmacy } },
    `Send a refill request for ${qty} × ${m.name} ${m.dose} to ${pharmacy}.`, { cost: "No payment is made by CareCircle." });
}

export function proposeAppointment(db: DB, now: Date, a: { title: string; starts_at: string; location?: string; with_whom?: string; transport?: string; notes?: string }) {
  const when = parseLocalDateTime(a.starts_at);
  if (when.getTime() < now.getTime()) throw new ToolError("IN_THE_PAST", "That time is in the past.");
  const clashes = (db.prepare("SELECT * FROM appointments WHERE status='scheduled' AND starts_at > ? AND starts_at < ?")
    .all(new Date(when.getTime() - 2 * HOUR).toISOString(), new Date(when.getTime() + 2 * HOUR).toISOString()) as Row[])
    .map((c) => `${c.title} at ${localStamp(c.starts_at)}`);
  const payload = { ...a, starts_at: when.toISOString() };
  return propose(db, now, { action: "schedule_appointment", payload },
    `Add "${a.title}" on ${localStamp(payload.starts_at)}${a.location ? ` at ${a.location}` : ""}.`,
    { conflicts_within_2h: clashes });
}

export function proposeCancelAppointment(db: DB, now: Date, appointmentId: string) {
  const a = db.prepare("SELECT * FROM appointments WHERE id=? AND status='scheduled'").get(appointmentId) as Row | undefined;
  if (!a) throw new ToolError("APPOINTMENT_NOT_FOUND", `No scheduled appointment with id ${appointmentId}. Use list_appointments for real ids.`);
  return propose(db, now, { action: "cancel_appointment", payload: { appointment_id: a.id } },
    `Cancel "${a.title}" on ${localStamp(a.starts_at)}.`);
}

export function listPending(db: DB) {
  return (db.prepare("SELECT * FROM pending_actions WHERE status='awaiting_confirmation' ORDER BY at").all() as Row[])
    .map((p) => ({ confirmation_id: p.id, action: p.action, summary: p.summary, requested_at: localStamp(p.at) }));
}

export function resolvePending(db: DB, now: Date, pid: string, approve: boolean, by: string) {
  const p = db.prepare("SELECT * FROM pending_actions WHERE id=?").get(pid) as Row | undefined;
  if (!p) throw new ToolError("CONFIRMATION_NOT_FOUND", `No pending action ${pid}.`);
  if (p.status !== "awaiting_confirmation")
    throw new ToolError("ALREADY_RESOLVED", `Action ${pid} is already ${p.status}; nothing was done twice.`);
  return tx(db, () => {
    const mark = (status: string) => db.prepare("UPDATE pending_actions SET status=?, resolved_at=? WHERE id=?").run(status, now.toISOString(), pid);
    if (!approve) { mark("cancelled"); return { confirmation_id: pid, status: "cancelled", summary: p.summary }; }
    const payload = JSON.parse(p.payload);
    let result: unknown;
    if (p.action === "request_refill") {
      const rid = id("rx");
      db.prepare("INSERT INTO refills (id, medication_id, at, quantity, pharmacy, status) VALUES (?,?,?,?,?,?)")
        .run(rid, payload.medication_id, now.toISOString(), payload.quantity, payload.pharmacy, "sent_to_pharmacy_simulated");
      db.prepare("UPDATE alerts SET acknowledged_by=?, acknowledged_at=? WHERE kind='refill_low' AND acknowledged_at IS NULL AND message LIKE ?")
        .run(by, now.toISOString(), `${findMedication(db, payload.medication_id).name}:%`);
      raiseAlert(db, now, "info", "refill_requested", `${p.summary} (approved by ${by})`);
      result = { refill_id: rid, status: "sent_to_pharmacy_simulated" };
    } else if (p.action === "schedule_appointment") {
      const aid = id("appt");
      db.prepare("INSERT INTO appointments (id, title, starts_at, location, with_whom, transport, notes, sample) VALUES (?,?,?,?,?,?,?,0)")
        .run(aid, payload.title, payload.starts_at, payload.location ?? null, payload.with_whom ?? null, payload.transport ?? null, payload.notes ?? null);
      raiseAlert(db, now, "info", "appointment_added", p.summary);
      result = { appointment_id: aid };
    } else if (p.action === "cancel_appointment") {
      const r = db.prepare("UPDATE appointments SET status='cancelled' WHERE id=? AND status='scheduled'").run(payload.appointment_id);
      if (r.changes !== 1) throw new ToolError("APPOINTMENT_NOT_FOUND", "Appointment no longer scheduled.");
      raiseAlert(db, now, "info", "appointment_cancelled", p.summary);
      result = { appointment_id: payload.appointment_id, status: "cancelled" };
    }
    mark("done");
    return { confirmation_id: pid, status: "done", summary: p.summary, result };
  });
}

// ---------- wellbeing & safety ----------
const RED_FLAGS: [RegExp, string][] = [
  [/chest (pain|tight|pressure)/i, "chest pain"], [/(short(ness)? of breath|can'?t breathe|breathless)/i, "breathing difficulty"],
  [/\b(fell|fall(en)?|fallen down)\b/i, "a fall"], [/(faint|passed out|black(ed)? out|unconscious)/i, "fainting"],
  [/(slurred|can'?t speak|face (droop|numb))/i, "possible stroke sign"], [/(numb|weak(ness)? in (my )?(arm|leg|face))/i, "one-sided weakness/numbness"],
  [/(confus|don'?t know where)/i, "confusion"], [/(severe|worst) headache/i, "severe headache"], [/(bleeding|vomit(ing)? blood|blood in)/i, "bleeding"],
];
const WATCH = [/dizz/i, /(nause|vomit)/i, /(fever|chills)/i, /(pain|ache)/i, /(lonely|sad|depress|anxious)/i, /(not eating|no appetite)/i, /(can'?t sleep|insomnia)/i];

export function logWellbeing(db: DB, now: Date, mood: string | undefined, symptoms: string) {
  const red = RED_FLAGS.filter(([re]) => re.test(symptoms)).map(([, l]) => l);
  const watch = WATCH.filter((re) => re.test(symptoms)).length > 0;
  const wid = id("wb");
  db.prepare("INSERT INTO wellbeing (id, at, mood, symptoms, red_flag) VALUES (?,?,?,?,?)")
    .run(wid, now.toISOString(), mood ?? null, symptoms, red.length ? 1 : 0);
  let alert = null;
  if (red.length) alert = raiseAlert(db, now, "urgent", "red_flag_symptom", `Red-flag symptom reported (${red.join(", ")}): "${symptoms}"`);
  else if (watch) alert = raiseAlert(db, now, "warning", "symptom", `Symptom reported: "${symptoms}"${mood ? ` (mood: ${mood})` : ""}`);
  return {
    entry_id: wid, triage: red.length ? "urgent" : watch ? "watch" : "routine", red_flags: red, family_alerted: !!alert,
    guidance: red.length
      ? "Possible emergency. Tell the user to call emergency services now (112 in India, 911 in the US) or press their emergency button. Family has been alerted. Do NOT give medical advice."
      : watch ? "Family has been informed. Suggest rest and water, and contacting their doctor if it gets worse. Do NOT diagnose."
      : "Logged.",
  };
}

const SCAM_SIGNALS: [RegExp, number, string][] = [
  [/\b(otp|one[- ]time (pass)?code|pin|cvv|password)\b/i, 35, "asks for a code/PIN/password"],
  [/(gift ?card|itunes|google play card|crypto|bitcoin|wire transfer|western union)/i, 30, "unusual payment method"],
  [/(anydesk|teamviewer|quick ?support|remote access|install (this|an) app|screen share)/i, 35, "asks to install remote-access software"],
  [/(urgent|immediately|within (an|1|one|24) ?hours?|right now|last chance|account (will be )?(blocked|suspended|frozen))/i, 15, "pressure / urgency"],
  [/(kyc|verify your (account|identity)|update your (pan|aadhaar|details))/i, 20, "fake verification request"],
  [/(won|lottery|prize|reward|cashback|refund pending)/i, 20, "too-good-to-be-true prize/refund"],
  [/(police|cbi|customs|tax department|income tax|irs|court|arrest|digital arrest|parcel (seized|held))/i, 30, "impersonates authority / threat"],
  [/(don'?t tell|keep (this|it) (a )?secret|do not inform)/i, 25, "asks for secrecy"],
  [/(grand(son|daughter)|it'?s me).*(trouble|accident|hospital|jail|need money)/i, 30, "family-emergency money request"],
  [/(bank|sbi|hdfc|icici|paypal|amazon).*(call|link|click|verify)/i, 10, "claims to be a bank/company"],
  [/(https?:\/\/|bit\.ly|tinyurl)/i, 10, "contains a link"],
];

export function assessScam(db: DB, now: Date, text: string, channel = "call") {
  const hits = SCAM_SIGNALS.filter(([re]) => re.test(text));
  const score = Math.min(100, hits.reduce((s, [, w]) => s + w, 0));
  const verdict = score >= 50 ? "likely_scam" : score >= 25 ? "suspicious" : "no_strong_signals";
  let alerted = false;
  if (verdict !== "no_strong_signals") {
    raiseAlert(db, now, verdict === "likely_scam" ? "urgent" : "warning", "scam_guard",
      `Possible ${channel} scam (risk ${score}/100): ${hits.map((h) => h[2]).join("; ")}.`);
    alerted = true;
  }
  return {
    risk_score: score, verdict, signals: hits.map((h) => h[2]), family_alerted: alerted,
    advice: verdict === "no_strong_signals"
      ? "No strong scam signals found, but never share codes or PINs with callers."
      : "Do not share any code, PIN or bank detail and do not install anything. Hang up and call your family or the bank's official number yourself.",
  };
}

// ---------- alerts / family ----------
export function raiseAlert(db: DB, now: Date, severity: "info" | "warning" | "urgent", kind: string, message: string) {
  const aid = id("alert");
  db.prepare("INSERT INTO alerts (id, at, severity, kind, message) VALUES (?,?,?,?,?)").run(aid, now.toISOString(), severity, kind, message);
  return { alert_id: aid, severity, kind, message };
}

export function listAlerts(db: DB, includeAcknowledged: boolean) {
  return (db.prepare(`SELECT * FROM alerts ${includeAcknowledged ? "" : "WHERE acknowledged_at IS NULL"} ORDER BY at DESC LIMIT 50`).all() as Row[])
    .sort((a, b) => sev(b.severity) - sev(a.severity) || b.at.localeCompare(a.at))
    .map((a) => ({ id: a.id, at: localStamp(a.at), severity: a.severity, kind: a.kind, message: a.message,
      acknowledged_by: a.acknowledged_by }));
}
const sev = (s: string) => ({ urgent: 3, warning: 2, info: 1 } as Record<string, number>)[s] ?? 0;

export function acknowledgeAlert(db: DB, now: Date, alertId: string, by: string) {
  const r = db.prepare("UPDATE alerts SET acknowledged_by=?, acknowledged_at=? WHERE id=? AND acknowledged_at IS NULL").run(by, now.toISOString(), alertId);
  if (r.changes !== 1) throw new ToolError("ALERT_NOT_FOUND", `No open alert ${alertId}.`);
  return { alert_id: alertId, acknowledged_by: by };
}

export function familyDigest(db: DB, now: Date, date?: string) {
  const o = careOverview(db, now, date);
  const day0 = parseDay(date, now); day0.setHours(0, 0, 0, 0);
  const wb = (db.prepare("SELECT * FROM wellbeing WHERE at >= ? AND at < ? ORDER BY at").all(day0.toISOString(), new Date(day0.getTime() + 24 * HOUR).toISOString()) as Row[])
    .map((w) => ({ at: localStamp(w.at), mood: w.mood, symptoms: w.symptoms, red_flag: !!w.red_flag }));
  const total = o.medication_schedule.length;
  const due = o.counts.taken + o.counts.missed;
  return {
    date: o.date,
    adherence: { taken: o.counts.taken, missed: o.counts.missed, scheduled_today: total,
      adherence_so_far_pct: due ? Math.round((o.counts.taken / due) * 100) : null },
    missed: o.medication_schedule.filter((s) => s.status === "missed").map((s) => `${s.medication} ${s.time}`),
    wellbeing: wb,
    open_alerts: listAlerts(db, false),
    upcoming_appointments: listAppointments(db, now, undefined, 7),
    refills_needed: forecastRefills(db, now, 7).filter((r) => r.needs_refill),
    people: db.prepare("SELECT id, name, role, relation FROM people").all(),
  };
}

export function notifyFamily(db: DB, now: Date, message: string, severity: "info" | "warning" | "urgent") {
  const caregivers = db.prepare("SELECT name, relation FROM people WHERE role='caregiver'").all() as Row[];
  const a = raiseAlert(db, now, severity, "message_to_family", message);
  return { ...a, delivered_to_dashboard_of: caregivers.map((c) => `${c.name} (${c.relation})`),
    channel: "CareCircle family dashboard (SMS/push delivery is not implemented in this demo)" };
}

export function activityLog(db: DB, limit = 30) {
  return (db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT ?").all(limit) as Row[]).map((r) => ({
    at: localStamp(r.at), tool: r.tool, args: r.args ? JSON.parse(r.args) : null, ok: !!r.ok, code: r.code, latency_ms: r.latency_ms,
  }));
}
