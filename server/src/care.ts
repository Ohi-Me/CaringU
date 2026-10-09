// Domain logic for CareCircle. Deterministic and model-free: the LLM only decides
// WHICH of these to call; every fact and every safety rule lives here.
import { randomUUID } from "node:crypto";
import { type DB, tx } from "./db.js";
import { screenScam, triageText } from "./safety.js";
import * as family from "./family.js";

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

// CareCircle only knows about doses that were reported to it, so it never says a
// dose is "safe". It reports what is recorded and points to a pharmacist when in doubt.
export const RECORD_BASIS = "Based only on doses reported to CareCircle; doses that were not reported are unknown.";
export const MISSED_DOSE_GUIDANCE = "Do not take two doses together to make up. Whether a late dose should still be taken depends on the medicine: ask the pharmacist or doctor.";

export function doseStatus(db: DB, ref: string, now: Date) {
  const m = findMedication(db, ref);
  const last = lastDose(db, m.id);
  const hoursSince = last ? (now.getTime() - new Date(last.taken_at).getTime()) / HOUR : null;
  const withinGap = hoursSince !== null && hoursSince < m.min_gap_hours;
  const next = [0, 1].flatMap((d) => {
    const day = new Date(now.getTime() + d * 24 * HOUR);
    return m.times.map((t) => slotOn(day, t));
  }).find((s) => s.getTime() > now.getTime());
  const today = careOverview(db, now).medication_schedule.filter((s) => s.medication_id === m.id)
    .map((s) => ({ time: s.time, status: s.status, recorded_at: s.taken_at }));
  return {
    medication: { id: m.id, name: m.name, dose: m.dose, purpose: m.purpose, with_food: m.with_food },
    last_recorded: last ? localStamp(last.taken_at) : null,
    hours_since_last_record: hoursSince === null ? null : Math.round(hoursSince * 10) / 10,
    min_gap_hours: m.min_gap_hours,
    recorded_within_min_gap: withinGap,
    today,
    next_scheduled: next ? localStamp(next.toISOString()) : null,
    pills_left: m.pills_left,
    basis: RECORD_BASIS,
    guidance: withinGap
      ? `A dose is already recorded at ${localStamp(last!.taken_at)}. Tell the user not to take another ${m.name} now.`
      : today.some((s) => s.status === "missed")
        ? `A scheduled dose has no record. Do not say it is safe or tell them to take it: ask them to check their pill organiser; if they still aren't sure, ${MISSED_DOSE_GUIDANCE}`
        : "No dose recorded within the minimum gap. Do not say it is safe: say what is recorded and when it is scheduled; if they are unsure whether they already took it, ask them to check their pill organiser or ask a pharmacist.",
  };
}

/** "HH:MM" (today), "YYYY-MM-DD HH:MM", or empty for now. Must be within the past 24h. */
function parseTakenAt(s: string | undefined, now: Date) {
  if (!s || s === "now") return now;
  let d: Date;
  const hm = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (hm) { d = new Date(now); d.setHours(+hm[1], +hm[2], 0, 0); }
  else d = parseLocalDateTime(s.trim());
  if (d.getTime() > now.getTime() + 5 * 60_000) throw new ToolError("TAKEN_AT_IN_FUTURE", `taken_at ${s} is in the future.`);
  if (now.getTime() - d.getTime() > 24 * HOUR) throw new ToolError("TAKEN_AT_TOO_OLD", "Can only record doses from the last 24 hours.");
  return d;
}

export function recordDose(db: DB, ref: string, recordedBy: string, now: Date,
  opts: { taken_at?: string; extra_dose_confirmed?: boolean; note?: string } = {}) {
  const m = findMedication(db, ref);
  const at = parseTakenAt(opts.taken_at, now);
  const nearby = (db.prepare("SELECT * FROM dose_log WHERE medication_id = ? AND taken_at > ? AND taken_at < ? ORDER BY taken_at DESC")
    .all(m.id, new Date(at.getTime() - m.min_gap_hours * HOUR).toISOString(), new Date(at.getTime() + m.min_gap_hours * HOUR).toISOString()) as Row[])[0];
  if (nearby && !opts.extra_dose_confirmed) {
    const gapMin = Math.abs(at.getTime() - new Date(nearby.taken_at).getTime()) / 60_000;
    // Same dose reported again (e.g. "I took it this morning at 9" when 09:05 is recorded): nothing to do.
    if (opts.taken_at && gapMin <= 60)
      return { status: "already_recorded", medication: m.name, recorded_at: localStamp(nearby.taken_at), changed: false };
    return {
      status: "possible_duplicate", medication: m.name, changed: false,
      existing_record: localStamp(nearby.taken_at), min_gap_hours: m.min_gap_hours,
      question_for_user: `My records show ${m.name} at ${localStamp(nearby.taken_at).split(" ")[1]}. Is that the dose you mean, or did you take another one just now?`,
      next_step: "Ask the question. If they took ANOTHER one, call record_dose again with extra_dose_confirmed=true. If it is the same dose, record nothing.",
    };
  }
  if (m.pills_left < m.pills_per_dose)
    throw new ToolError("OUT_OF_STOCK", `No ${m.name} pills left according to the record. Request a refill.`);
  return tx(db, () => {
    const doseId = id("dose");
    db.prepare("INSERT INTO dose_log (id, medication_id, taken_at, recorded_by, note, extra) VALUES (?,?,?,?,?,?)")
      .run(doseId, m.id, at.toISOString(), recordedBy, opts.note ?? null, nearby ? 1 : 0);
    let extra_dose: Record<string, string> | null = null;
    if (nearby) {
      const msg = `Possible extra dose: ${m.name} recorded at ${localStamp(nearby.taken_at).split(" ")[1]} and again at ${localStamp(at.toISOString()).split(" ")[1]} (minimum gap ${m.min_gap_hours}h). Please call her.`;
      raiseAlert(db, now, "urgent", "extra_dose", msg);
      extra_dose = {
        alert: msg,
        guidance_for_user: `Don't take any more ${m.name} today unless a doctor or pharmacist tells you to. Please call your pharmacist or doctor now and tell them you may have taken an extra dose. If you feel faint, very dizzy, confused or have chest pain, call 112 straight away. I've told your family.`,
      };
    }
    db.prepare("UPDATE medications SET pills_left = pills_left - pills_per_dose WHERE id = ?").run(m.id);
    const after = findMedication(db, m.id);
    let refill_warning: string | null = null;
    if (after.days_of_supply !== null && after.days_of_supply <= 5) {
      refill_warning = `${after.name}: only ${after.pills_left} pills left (~${after.days_of_supply} days).`;
      const open = db.prepare("SELECT 1 FROM alerts WHERE kind='refill_low' AND message LIKE ? AND acknowledged_at IS NULL")
        .get(`${after.name}:%`);
      if (!open) raiseAlert(db, now, "warning", "refill_low", refill_warning);
    }
    return { status: extra_dose ? "extra_dose_recorded" : "recorded", changed: true, dose_id: doseId, medication: after.name,
      taken_at: localStamp(at.toISOString()), pills_left: after.pills_left, refill_warning, extra_dose };
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
    missed_dose_guidance: schedule.some((s) => s.status === "missed") ? MISSED_DOSE_GUIDANCE : null,
    basis: RECORD_BASIS,
    appointments: listAppointments(db, now, ymd(day), 1),
    open_alerts: listAlerts(db, false, now).slice(0, 5),
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

// ---------- wellbeing & safety (rules live in safety.ts) ----------
export const EMERGENCY_LINE = "This could be an emergency. Please call 112 now (911 in the US), or press your emergency button.";

export function logWellbeing(db: DB, now: Date, mood: string | undefined, symptoms: string) {
  const t = triageText(symptoms);
  const wid = id("wb");
  db.prepare("INSERT INTO wellbeing (id, at, mood, symptoms, red_flag) VALUES (?,?,?,?,?)")
    .run(wid, now.toISOString(), mood ?? null, symptoms, t.triage === "urgent" ? 1 : 0);
  let alert = null;
  if (t.triage === "urgent") alert = raiseAlert(db, now, "urgent", "red_flag_symptom", `Possible emergency (${t.signals.join(", ")}): "${symptoms}". Call her now.`);
  else if (t.triage === "watch") alert = raiseAlert(db, now, "warning", "symptom", `Symptom reported (${t.signals.join(", ")}): "${symptoms}"${mood ? ` (mood: ${mood})` : ""}`);
  return {
    entry_id: wid, triage: t.triage, signals: t.signals, family_alerted: !!alert, alert_id: alert?.alert_id ?? null, notified: alert?.notified ?? [],
    say_first: t.triage === "urgent" ? EMERGENCY_LINE : null,
    guidance: t.triage === "urgent"
      ? "Start the reply with say_first. Family has been alerted. Do NOT diagnose or suggest waiting."
      : t.triage === "watch" ? "Family has been informed. Suggest rest, water, and contacting their doctor if it gets worse or they are worried. Do NOT diagnose."
      : "Logged. Nothing concerning detected.",
  };
}

export function assessScam(db: DB, now: Date, text: string, channel = "call") {
  const s = screenScam(text);
  let alert: { alert_id: string; notified: string[] } | null = null;
  if (s.verdict !== "no_strong_signals") {
    // Several messages about the same incident update one open alert instead of creating new ones.
    const open = db.prepare("SELECT * FROM alerts WHERE kind='scam_guard' AND acknowledged_at IS NULL AND at > ? ORDER BY at DESC LIMIT 1")
      .get(new Date(now.getTime() - 15 * 60_000).toISOString()) as Row | undefined;
    if (open) {
      family.logEvent(db, open.id, now, "update", `She described more: ${s.signals.join("; ")}${s.in_progress ? " (caller still on the line)" : ""}`);
      alert = { alert_id: open.id, notified: family.notifiedSoFar(db, open) };
    } else
      alert = raiseAlert(db, now, s.verdict === "likely_scam" ? "urgent" : "warning", "scam_guard",
        `${s.verdict === "likely_scam" ? "Likely" : "Possible"} ${s.scam_type ?? ""} scam by ${channel}${s.in_progress ? " — the caller is STILL ON THE LINE" : ""} (risk ${s.risk_score}/100): ${s.signals.join("; ")}.`);
  }
  return {
    ...s, channel, family_alerted: !!alert, alert_id: alert?.alert_id ?? null, notified: alert?.notified ?? [],
    say_first: s.verdict === "likely_scam" ? (s.in_progress ? "Hang up now." : "This looks like a scam.") : null,
    advice: s.verdict === "no_strong_signals"
      ? "No strong scam signals. Still: never share codes or PINs, and if unsure call back on an official number you already have."
      : "Do not share any code, PIN or card detail, do not pay, scan or install anything. Hang up, and if you want to check, call your family or the official number you already have (for a bank: the number on the back of your card).",
  };
}


// ---------- alerts / family ----------
export function raiseAlert(db: DB, now: Date, severity: "info" | "warning" | "urgent", kind: string, message: string) {
  const aid = id("alert");
  db.prepare("INSERT INTO alerts (id, at, severity, kind, message) VALUES (?,?,?,?,?)").run(aid, now.toISOString(), severity, kind, message);
  family.startEscalation(db, aid, severity, now);
  return { alert_id: aid, severity, kind, message, notified: family.notifiedSoFar(db, { severity, escalation_level: severity === "urgent" ? 1 : 0 }) };
}

export function listAlerts(db: DB, includeAcknowledged: boolean, now?: Date) {
  if (now) family.runEscalations(db, now);
  return (db.prepare(`SELECT * FROM alerts ${includeAcknowledged ? "" : "WHERE acknowledged_at IS NULL"} ORDER BY at DESC LIMIT 50`).all() as Row[])
    .sort((a, b) => Number(!!a.claimed_by) - Number(!!b.claimed_by) || sev(b.severity) - sev(a.severity) || b.at.localeCompare(a.at))
    .map((a) => ({ id: a.id, at: localStamp(a.at), severity: a.severity, kind: a.kind, message: a.message,
      acknowledged_by: a.acknowledged_by, claimed_by: a.claimed_by, claimed_action: a.claimed_action,
      notified: family.notifiedSoFar(db, a),
      escalates_at: a.next_escalation_at ? localStamp(a.next_escalation_at) : null,
      timeline: family.alertTimeline(db, a.id) }));
}
const sev = (s: string) => ({ urgent: 3, warning: 2, info: 1 } as Record<string, number>)[s] ?? 0;

export function acknowledgeAlert(db: DB, now: Date, alertId: string, by: string) {
  const r = db.prepare("UPDATE alerts SET acknowledged_by=?, acknowledged_at=?, next_escalation_at=NULL WHERE id=? AND acknowledged_at IS NULL").run(by, now.toISOString(), alertId);
  if (r.changes !== 1) throw new ToolError("ALERT_NOT_FOUND", `No open alert ${alertId}.`);
  family.logEvent(db, alertId, now, "handled", by);
  return { alert_id: alertId, acknowledged_by: by };
}

export function respondToAlert(db: DB, now: Date, alertId: string, responder: string, action: "calling_now" | "on_my_way" | "will_call_soon" | "handled", message?: string) {
  const r = family.respondToAlert(db, now, alertId, responder, action, message);
  if (!r) throw new ToolError("ALERT_NOT_FOUND", `No alert ${alertId}. Use list_alerts for real ids.`);
  if (r.already) throw new ToolError("ALREADY_CLAIMED", `${r.claimed_by} is already handling this alert (${String(r.action).replace(/_/g, " ")}).`, false, r);
  return r;
}

export function sendMessageToElder(db: DB, now: Date, from: string, text: string) {
  return { ...family.sendToElder(db, now, from.split(" ")[0], `Message from ${from.split(" ")[0]}: ${text}`), delivery: "spoken aloud on her CareCircle device" };
}

export function getAnnouncements(db: DB, now: Date) {
  family.runEscalations(db, now);
  return family.pendingAnnouncements(db);
}

export function markAnnouncementsHeard(db: DB, now: Date, ids: string[]) {
  return { marked: family.markHeard(db, now, ids) };
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
    open_alerts: listAlerts(db, false, now),
    messages_to_her: family.recentMessages(db, 5),
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
