// Family loop: escalation ladder for urgent alerts and two-way messages between
// caregivers and the older adult's device. Deterministic and driven by the
// (demo) clock, so escalation can be tested and demonstrated reproducibly.
import { randomUUID } from "node:crypto";
import type { DB } from "./db.js";

type Row = Record<string, any>;
export const ESCALATION_MINUTES = Number(process.env.ESCALATION_MINUTES ?? 3);
const MIN = 60_000;
const hhmm = (iso: string) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

export function caregivers(db: DB) {
  return db.prepare("SELECT id, name, relation, priority FROM people WHERE role='caregiver' ORDER BY COALESCE(priority, 99), name").all() as Row[];
}

export function logEvent(db: DB, alertId: string, now: Date, event: string, detail?: string) {
  db.prepare("INSERT INTO alert_events (alert_id, at, event, detail) VALUES (?,?,?,?)").run(alertId, now.toISOString(), event, detail ?? null);
}

/** Called when an alert is created. Urgent alerts go to the first caregiver and start the ladder. */
export function startEscalation(db: DB, alertId: string, severity: string, now: Date) {
  const cg = caregivers(db);
  if (severity === "urgent" && cg.length) {
    db.prepare("UPDATE alerts SET escalation_level=1, next_escalation_at=? WHERE id=?")
      .run(new Date(now.getTime() + ESCALATION_MINUTES * MIN).toISOString(), alertId);
    logEvent(db, alertId, now, "notified", `${cg[0].name} (${cg[0].relation}) — urgent, must respond within ${ESCALATION_MINUTES} min`);
  } else {
    logEvent(db, alertId, now, "notified", `family dashboard (${cg.map((c) => c.name).join(", ")})`);
  }
}

/**
 * Advances every urgent alert nobody has responded to: next caregiver, then the
 * older adult is told directly that family could not be reached. Idempotent.
 */
export function runEscalations(db: DB, now: Date) {
  const cg = caregivers(db);
  const due = db.prepare(`SELECT * FROM alerts WHERE severity='urgent' AND acknowledged_at IS NULL AND claimed_by IS NULL
    AND next_escalation_at IS NOT NULL AND next_escalation_at <= ?`).all(now.toISOString()) as Row[];
  const changed: string[] = [];
  for (const a of due) {
    // Catch up step by step if several windows have passed (e.g. after a long pause).
    let level = a.escalation_level as number;
    let next = new Date(a.next_escalation_at);
    while (next.getTime() <= now.getTime() && level <= cg.length) {
      level++;
      if (level <= cg.length) {
        const p = cg[level - 1];
        logEvent(db, a.id, next, "escalated", `No response from ${cg[level - 2].name} in ${ESCALATION_MINUTES} min → ${p.name} (${p.relation})`);
        next = new Date(next.getTime() + ESCALATION_MINUTES * MIN);
      } else {
        logEvent(db, a.id, next, "unreached", "No caregiver responded; told her directly to call 112 if she needs help");
        sendToElder(db, next, "CareCircle", "I haven't been able to reach Ravi or Neha yet. If you need help, please call 112 now, or press your emergency button.", a.id);
      }
    }
    db.prepare("UPDATE alerts SET escalation_level=?, next_escalation_at=? WHERE id=?")
      .run(level, level <= cg.length ? next.toISOString() : null, a.id);
    changed.push(a.id);
  }
  return changed;
}

/** Who has been notified so far, derived from the level. */
export function notifiedSoFar(db: DB, a: Row) {
  const cg = caregivers(db);
  if (a.severity !== "urgent") return cg.map((c) => c.name);
  return cg.slice(0, Math.min(a.escalation_level, cg.length)).map((c) => c.name);
}

export function alertTimeline(db: DB, alertId: string) {
  return (db.prepare("SELECT * FROM alert_events WHERE alert_id=? ORDER BY at, id").all(alertId) as Row[])
    .map((e) => ({ at: hhmm(e.at), event: e.event, detail: e.detail }));
}

const ACTION_TEXT: Record<string, (n: string) => string> = {
  calling_now: (n) => `${n} is calling you right now. Please pick up.`,
  on_my_way: (n) => `${n} is on the way to you.`,
  will_call_soon: (n) => `${n} will call you in a few minutes.`,
};

/** A caregiver takes responsibility for an alert. Stops escalation and tells the older adult. */
export function respondToAlert(db: DB, now: Date, alertId: string, responder: string, action: "calling_now" | "on_my_way" | "will_call_soon" | "handled", message?: string) {
  const a = db.prepare("SELECT * FROM alerts WHERE id=?").get(alertId) as Row | undefined;
  if (!a) return null;
  if (a.acknowledged_at || a.claimed_by) return { already: true, claimed_by: a.claimed_by ?? a.acknowledged_by, action: a.claimed_action };
  const name = responder.split(" ")[0];
  db.prepare("UPDATE alerts SET claimed_by=?, claimed_action=?, next_escalation_at=NULL" + (action === "handled" ? ", acknowledged_by=?, acknowledged_at=?" : "") + " WHERE id=?")
    .run(...(action === "handled" ? [responder, action, responder, now.toISOString(), alertId] : [responder, action, alertId]));
  logEvent(db, alertId, now, "responded", `${responder}: ${action.replace(/_/g, " ")}${message ? ` — "${message}"` : ""}`);
  // A typed message says it best; the canned action text is only used when there is none
  // (except "calling now", which she needs to hear so she picks up).
  const spoken = message
    ? `${action === "calling_now" ? ACTION_TEXT.calling_now(name) + " " : ""}Message from ${name}: ${message}`
    : action !== "handled" ? ACTION_TEXT[action](name) : "";
  const msg = spoken ? sendToElder(db, now, name, spoken, alertId) : null;
  return { already: false, claimed_by: responder, action, message_to_elder: msg };
}

export function sendToElder(db: DB, now: Date, from: string, text: string, alertId?: string) {
  const mid = `msg_${randomUUID().slice(0, 8)}`;
  db.prepare("INSERT INTO messages (id, at, from_name, to_elder, text, alert_id) VALUES (?,?,?,?,?,?)").run(mid, now.toISOString(), from, 1, text, alertId ?? null);
  return { message_id: mid, from, text, at: hhmm(now.toISOString()) };
}

export function pendingAnnouncements(db: DB) {
  return (db.prepare("SELECT * FROM messages WHERE to_elder=1 AND heard_at IS NULL ORDER BY at").all() as Row[])
    .map((m) => ({ message_id: m.id, from: m.from_name, text: m.text, at: hhmm(m.at) }));
}

export function markHeard(db: DB, now: Date, ids: string[]) {
  const st = db.prepare("UPDATE messages SET heard_at=? WHERE id=? AND heard_at IS NULL");
  return ids.reduce((n, i) => n + Number(st.run(now.toISOString(), i).changes), 0);
}

export function recentMessages(db: DB, limit = 10) {
  return (db.prepare("SELECT * FROM messages ORDER BY at DESC LIMIT ?").all(limit) as Row[])
    .map((m) => ({ from: m.from_name, text: m.text, at: hhmm(m.at), heard: !!m.heard_at }));
}
