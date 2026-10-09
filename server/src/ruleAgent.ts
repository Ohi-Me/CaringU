// Deterministic fallback planner, used when no LLM is configured or the LLM fails.
// It still acts only through real MCP tool calls; it just picks tools with rules.
// Emergencies and scams are handled before this runs (see screen.ts).
import type { CallTool, Turn } from "./agent.js";
import type { ScreenOutcome } from "./screen.js";

const YES = /^\s*(yes|yeah|yep|yup|sure|ok(ay)?|please( do)?|go ahead|do it|confirm|haan|ha|ji)\b/i;
const NO = /^\s*(no|nope|don'?t|cancel|stop|not now|nahi|never ?mind)\b/i;
const err = (r: any) => r?.error?.message ?? "something went wrong";

const MED_WORDS = /\b(levothyroxine|thyroid|metformin|sugar|diabet\w*|amlodipine|bp|blood ?pressure|pressure|atorvastatin|cholesterol|statin)\b/;
const GENERIC = new Set(["medicine", "medicines", "meds", "med", "pill", "pills", "tablet", "tablets", "dose", "doses", "medication",
  "medications", "morning", "evening", "night", "goli", "dawai", "dawa", "usual", "daily"]);

export async function ruleAgent(history: Turn[], speaker: string, call: CallTool, now: Date, screen: ScreenOutcome): Promise<string> {
  const text = history[history.length - 1].text.trim();
  const lower = text.toLowerCase();
  const prev = [...history].slice(0, -1).reverse().find((t) => t.role === "assistant")?.text ?? "";
  const isCaregiver = !/^asha/i.test(speaker);

  // ---- 0. The screen flagged a call/message as suspicious (not certain): advise caution ----
  if (screen.scamChecked && screen.scam?.verdict === "suspicious")
    return `Be careful, that sounds suspicious: it ${list(screen.scam.signals.slice(0, 2))}. Don't share any code, card details or open their link. If you want to check, call the company's official number yourself. I've let your family know.`;

  // ---- 1. Answers to a question we just asked ----
  const dupQ = /records show (\w+) at (\d{1,2}:\d{2})\. is that the dose you mean/i.exec(prev);
  if (dupQ) {
    if (/\b(another|again|extra|second|one more|two|twice|just now|yes)\b/i.test(lower) && !/\b(same|that one|that's the one|no\b)/i.test(lower)) {
      const r = await call("record_dose", { medication: dupQ[1], recorded_by: speaker, extra_dose_confirmed: true });
      if (!r.ok) return `I couldn't record that: ${err(r)}`;
      return r.data.extra_dose?.guidance_for_user ?? `Recorded ${r.data.medication}.`;
    }
    if (/\b(same|that one|that'?s it|that'?s the one|no|the morning one|earlier)\b/i.test(lower))
      return `Okay, nothing changed. Your ${dupQ[1]} stays recorded at ${dupQ[2]}.`;
  }
  if ((YES.test(lower) || NO.test(lower)) && /go ahead\?|shall i|should i/i.test(prev)) {
    const ov = await call("get_care_overview", {});
    const pending = ov?.data?.pending_confirmations ?? [];
    if (pending.length && /go ahead\?/i.test(prev)) {
      const p = pending[pending.length - 1];
      const r = await call("confirm_action", { confirmation_id: p.confirmation_id, approve: YES.test(lower), confirmed_by: speaker });
      if (!r.ok) return `I couldn't complete that: ${err(r)}`;
      return YES.test(lower) ? `Done. ${p.summary.replace(/\.$/, "")}. That's saved.` : "Okay, I've cancelled that. Nothing was sent.";
    }
    if (/message the family|ask (them|the family|ravi|neha)/i.test(prev) && YES.test(lower)) {
      const appt = /appointment is (.+?) with/i.exec(prev)?.[1];
      const r = await call("notify_family", { message: `${first(speaker)} needs a ride${appt ? ` to ${appt}` : ""}. Can someone take her?`, severity: "info" });
      return r.ok ? `I've asked ${names(r.data)} about the ride.` : `I couldn't message them: ${err(r)}`;
    }
  }
  if ((YES.test(lower) || NO.test(lower)) && lower.split(/\s+/).length <= 3) return "Sorry, what would you like me to do?";

  // ---- 2. Missed / forgotten doses: never advise taking it late ----
  if (/\b(forgot|forget|missed|skipped|didn'?t take|did not take|bhool)\b/.test(lower) && /\b(pill|tablet|medicine|meds?|dose|goli|dawai)\b|\b(take|took)\b/.test(lower) || MED_WORDS.test(lower) && /\b(forgot|missed|skipped)\b/.test(lower)) {
    const ov = await call("get_care_overview", {});
    if (!ov.ok) return `I couldn't check your schedule: ${err(ov)}`;
    const missed = ov.data.medication_schedule.filter((s: any) => s.status === "missed" || s.status === "due_now").map((s: any) => `${s.medication} from ${s.time}`);
    return `${missed.length ? `I don't have a record of ${list(missed)}. ` : ""}Please don't take two doses together to catch up. Whether to take a late dose depends on the medicine, so please ask your pharmacist or doctor. Would you like me to ask Ravi to call the pharmacist?`;
  }

  // ---- 3. "Did I take / should I take X?" (before "I took" so "have I taken" is a question) ----
  if (/\b(did i|have i|had i|should i|can i|could i|may i|shall i)\b.{0,15}\b(take|taken|had|have)\b|\bis it (time|okay|ok|safe) (for|to take)\b|\bwhen (do|should) i take\b/.test(lower)) {
    const med = medRef(lower);
    if (!med) {
      const ov = await call("get_care_overview", {});
      if (!ov.ok) return `I couldn't check: ${err(ov)}`;
      const s = ov.data.medication_schedule;
      const taken = s.filter((x: any) => x.status.startsWith("taken")).map((x: any) => `${x.medication} at ${x.taken_at.split(" ")[1]}`);
      const pend = s.filter((x: any) => x.status === "due_now" || x.status === "missed").map((x: any) => `${x.medication} (${x.time})`);
      return `Today I have records of ${list(taken) || "no doses yet"}.${pend.length ? ` I have no record yet of ${list(pend)}.` : ""} If you're not sure, check your pill organiser before taking anything.`;
    }
    const r = await call("check_dose_status", { medication: med });
    if (!r.ok) return medError(r, med) ?? `I couldn't check: ${err(r)}`;
    const d = r.data;
    if (d.recorded_within_min_gap) return `You already took your ${d.medication.name} at ${time(d.last_recorded)}. Please don't take another one. The next one is at ${time(d.next_scheduled)}.`;
    const todaySlot = d.today.find((s: any) => s.status === "due_now" || s.status === "missed");
    if (todaySlot) return `I don't have a record of your ${todaySlot.time} ${d.medication.name} today. If your pill organiser shows it's still there, it's due${d.medication.with_food ? ", with food" : ""}. If you're not sure whether you took it, please check with your pharmacist rather than risk a double dose. Tell me when you've taken it.`;
    return `Your last recorded ${d.medication.name} was ${d.last_recorded ? `at ${d.last_recorded}` : "never"}. The next one is scheduled for ${time(d.next_scheduled)}.`;
  }

  // ---- 4. "I took my X" -> record (duplicate-aware) ----
  if (/\b(i (just |already )?(took|take|had)|i'?ve (just |already )?(taken|had)|i have (just |already )?(taken|had)|just (took|had)|taken my|(le|kha|khaa) (li|liya|lii)|li hai|le chuki|kha chuki)\b/.test(lower)) {
    const med = medRef(lower);
    if (!med) return "Which medicine did you take?";
    const taken_at = whenTaken(lower, now);
    if (!taken_at && /(this morning|earlier|last night|yesterday)/.test(lower)) {
      const st = await call("check_dose_status", { medication: med });
      if (st.ok && st.data.recorded_within_min_gap) return `Yes, I have your ${st.data.medication.name} recorded at ${time(st.data.last_recorded)}. Nothing else to do.`;
      return "Roughly what time did you take it? For example, say 'at 9'.";
    }
    const r = await call("record_dose", { medication: med, recorded_by: speaker, ...(taken_at ? { taken_at } : {}) });
    if (!r.ok) return medError(r, med) ?? `I couldn't record that: ${err(r)}`;
    const d = r.data;
    if (d.status === "possible_duplicate") return d.question_for_user;
    if (d.status === "already_recorded") return `Yes, I already have your ${d.medication} recorded at ${time(d.recorded_at)}. Nothing else to do.`;
    return `Got it, ${d.medication} recorded at ${time(d.taken_at)}.${d.refill_warning ? ` By the way, you have ${d.refill_warning.split(": ")[1].replace(/\.$/, "")} left. Shall I prepare a refill request?` : ""}`;
  }

  // ---- 5. Refills ----
  if (/\b(refill|running (low|out)|almost out|nearly out|run out|few (pills|tablets) left|order (more|my)|pharmacy)\b/.test(lower) || (YES.test(lower) && /prepare a refill/i.test(prev))) {
    const fromPrev = /you have .*? left/i.test(prev) ? /(\w+) recorded at/i.exec(prev)?.[1] ?? null : null;
    const named = medRef(lower) ?? fromPrev;
    let target = named;
    let lead = "";
    if (!target) {
      const f = await call("forecast_refills", { horizon_days: 7 });
      if (!f.ok) return `I couldn't check supplies: ${err(f)}`;
      const need = f.data.find((m: any) => m.needs_refill);
      if (!need) return "All your medicines have more than a week's supply.";
      target = need.medication;
      lead = `${need.medication} runs out in about ${need.days_of_supply} days. `;
    }
    const p = await call("request_refill", { medication: target });
    if (!p.ok) return medError(p, target!) ?? `I couldn't prepare that: ${err(p)}`;
    return outcome(p.data, `${lead}I can ${lc(p.data.summary).replace(/\.$/, "")}. Shall I go ahead?`);
  }

  // ---- 6. Appointments ----
  if (/\b(appointment|doctor|clinic|check-?up|visit|dr\.?)\b/.test(lower)) {
    const r = await call("list_appointments", { days: 30 });
    if (!r.ok) return `I couldn't check appointments: ${err(r)}`;
    const appts = r.data as any[];
    const match = pickAppointment(lower, appts);
    if (/\b(cancel|call off|won'?t go|can'?t go|remove)\b/.test(lower)) {
      if (!match) return appts.length ? `Which appointment: ${list(appts.map((a) => `${a.title} on ${a.starts_at}`))}?` : "You have no appointments to cancel.";
      const p = await call("cancel_appointment", { appointment_id: match.id });
      if (!p.ok) return `I couldn't prepare that: ${err(p)}`;
      return outcome(p.data, `I can cancel your ${match.title} on ${match.starts_at}. Shall I go ahead?`);
    }
    if (/\b(pick me up|ride|drive me|take me|lift|transport)\b/.test(lower)) {
      const a = match ?? appts[0];
      const to = /\b(ravi|neha)\b/.exec(lower)?.[1];
      const r2 = await call("notify_family", { message: `${first(speaker)} asks${to ? ` ${cap(to)}` : ""}: can you take her to ${a ? `${a.title} on ${a.starts_at} at ${a.location}` : "her appointment"}?`, severity: "info" });
      return r2.ok ? `I've asked ${to ? cap(to) : names(r2.data)} to take you${a ? ` to ${a.title} on ${a.starts_at}` : ""}.` : `I couldn't send that: ${err(r2)}`;
    }
    const a = match ?? appts[0];
    if (!a) return "You have no appointments in the next month.";
    const noRide = a.transport === "NOT ARRANGED";
    return `Your ${match ? "" : "next "}appointment is ${a.title} with ${a.with_whom ?? "the doctor"} on ${a.starts_at}.${a.notes ? ` Remember: ${a.notes}.` : ""}${noRide ? " No ride is arranged yet. Shall I message the family to ask for one?" : ""}`;
  }

  // ---- 7. Message family ----
  if (/\b(tell|message|ask|remind|let) (my )?(son|daughter|ravi|neha|family|kids|children)\b|\b(call|ring) (my )?(son|daughter|ravi|neha)\b/.test(lower)) {
    const r = await call("notify_family", { message: `${first(speaker)}: ${text}`, severity: /urgent|emergency|help me/.test(lower) ? "urgent" : "info" });
    return r.ok ? `I've sent that to ${names(r.data)}.` : `I couldn't send it: ${err(r)}`;
  }

  // ---- 8. Calls / messages that the screen did not flag ----
  if (!screen.scamChecked && /\b(called|calling|caller|rang|phoned|message|sms|text(ed)?|email|whatsapp|link)\b/.test(lower)) {
    const r = await call("assess_scam_risk", { text, channel: /sms|text/.test(lower) ? "sms" : /email/.test(lower) ? "email" : /whatsapp/.test(lower) ? "whatsapp" : "call" });
    if (r.ok && r.data.verdict === "no_strong_signals")
      return `That doesn't look like a scam to me. ${/back of your card|official/.test(lower) ? "Calling the number on the back of your card is the safe way to check. " : ""}Just remember: never share a code or PIN with anyone who calls you.`;
    if (r.ok) return `${r.data.say_first ?? "That sounds suspicious."} ${r.data.advice} I've told your family.`;
  }

  // ---- 9. Caregiver summary ----
  if (isCaregiver || /\b(how (is|was) (mom|mum|maa|ma|asha|she)|digest|summary|report|any (problems|issues))\b/.test(lower)) {
    const r = await call("get_family_digest", {});
    if (!r.ok) return `I couldn't build the summary: ${err(r)}`;
    const d = r.data;
    const urgent = d.open_alerts.filter((a: any) => a.severity === "urgent");
    return [
      `Today ${d.adherence.taken} doses are recorded and ${d.adherence.missed} missed${d.missed.length ? ` (${list(d.missed)})` : ""}.`,
      urgent.length ? `${urgent.length} urgent alert${urgent.length > 1 ? "s" : ""}: ${urgent[0].message}` : `${d.open_alerts.length} open alerts, none urgent.`,
      d.refills_needed.length ? `Refill needed soon: ${list(d.refills_needed.map((x: any) => x.medication))}.` : "",
      d.upcoming_appointments[0] ? `Next appointment: ${d.upcoming_appointments[0].title} on ${d.upcoming_appointments[0].starts_at}, ride ${d.upcoming_appointments[0].transport === "NOT ARRANGED" ? "not arranged" : "arranged"}.` : "",
    ].filter(Boolean).join(" ");
  }

  // ---- 10. Default: today's overview ----
  const ov = await call("get_care_overview", {});
  if (!ov.ok) return `I couldn't load today's plan: ${err(ov)}`;
  const s = ov.data.medication_schedule;
  const due = s.filter((x: any) => x.status === "due_now");
  const missed = s.filter((x: any) => x.status === "missed");
  const appt = ov.data.appointments[0];
  return [
    due.length ? `It's time for your ${list(due.map((x: any) => x.medication))}.` : missed.length ? "" : "No medicines are due right now.",
    missed.length ? `I don't have a record of ${list(missed.map((x: any) => `${x.medication} from ${x.time}`))}. Did you take ${missed.length > 1 ? "them" : "it"}?` : "",
    appt ? `You have ${appt.title} at ${time(appt.starts_at)} today.` : "",
  ].filter(Boolean).join(" ") || "Everything is on track today.";
}

// ---------- helpers ----------
/** Reply for a consequential action: decided via MCP elicitation, or still waiting for a spoken yes. */
function outcome(d: any, askText: string) {
  if (d.confirmed_via === "mcp_elicitation") {
    if (d.status === "done") return `Done. ${d.summary.replace(/.$/, "")}.`;
    if (d.status === "cancelled") return "Okay, I haven't done anything.";
    return "I didn't get an answer, so I haven't done anything. It's saved as a request your family can approve.";
  }
  return askText;
}
// A known medicine word, or the unknown word after "my" (so "aspirin" reaches the
// server and comes back as MEDICATION_NOT_FOUND instead of being silently ignored).
function medRef(lower: string): string | null {
  const m = MED_WORDS.exec(lower);
  if (m) return m[1];
  const u = /\b(?:took|taken|take|had|of) (?:my|the|a|an|one|another|some) ([a-z][a-z-]{2,})/.exec(lower);
  return u && !GENERIC.has(u[1]) ? u[1] : null;
}
function medError(r: any, med: string) {
  if (r.error.code === "AMBIGUOUS_MEDICATION") return `Which one: ${r.error.details.candidates.map((c: any) => c.name).join(" or ")}?`;
  if (r.error.code === "MEDICATION_NOT_FOUND") return `I don't see ${med} in your medicine list, which has ${list(r.error.details.known)}. Please check with your doctor or pharmacist before taking anything new.`;
  return null;
}
/** "at 9", "at 9:30", "at 9 am", "an hour ago", "30 minutes ago" -> "HH:MM" today. */
function whenTaken(lower: string, now: Date): string | null {
  const at = /\bat (\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/.exec(lower);
  if (at) {
    let h = +at[1];
    if (at[3]?.startsWith("p") && h < 12) h += 12;
    if (at[3]?.startsWith("a") && h === 12) h = 0;
    if (h > 23) return null;
    return `${String(h).padStart(2, "0")}:${at[2] ?? "00"}`;
  }
  const ago = /\b(an?|one|\d{1,3}) (hour|hr|minute|min)s? ago\b/.exec(lower);
  if (ago) {
    const n = /^\d+$/.test(ago[1]) ? +ago[1] : 1;
    const d = new Date(now.getTime() - n * (ago[2].startsWith("h") ? 3_600_000 : 60_000));
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  return null;
}
const TOPIC: [RegExp, RegExp][] = [
  [/\b(eye|eyes|vision|sight|glasses)\b/, /eye|vision/i],
  [/\b(heart|cardio\w*|bp|blood pressure)\b/, /cardio|heart/i],
  [/\b(sugar|diabet\w*)\b/, /diabet|sugar|endocr/i],
];
function pickAppointment(lower: string, appts: any[]) {
  for (const [q, t] of TOPIC) if (q.test(lower)) { const a = appts.find((x) => t.test(`${x.title} ${x.location} ${x.with_whom}`)); if (a) return a; }
  return null;
}
const time = (stamp: string) => stamp?.split(" ")[1] ?? stamp;
const list = (xs: string[]) => xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
const first = (speaker: string) => speaker.split(" ")[0];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const lc = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const names = (d: any) => list((d.delivered_to_dashboard_of ?? []).map((x: string) => x.split(" ")[0]));
