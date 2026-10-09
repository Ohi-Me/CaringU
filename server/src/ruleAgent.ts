// Deterministic fallback planner. Used when no LLM is configured or the LLM fails.
// It still goes through real MCP tool calls; it just picks tools with rules.
import type { CallTool, Turn } from "./agent.js";

const YES = /^(yes|yeah|yep|sure|ok(ay)?|please do|go ahead|do it|confirm|haan|ha)\b/i;
const NO = /^(no|nope|don'?t|cancel|stop|not now|nahi)\b/i;

const err = (r: any) => r?.error?.message ?? "something went wrong";

export async function ruleAgent(history: Turn[], speaker: string, call: CallTool): Promise<string> {
  const text = history[history.length - 1].text.trim();
  const lower = text.toLowerCase();
  const prevAssistant = [...history].reverse().find((t) => t.role === "assistant")?.text ?? "";

  // 1) Yes/no answer to a pending confirmation.
  if ((YES.test(lower) || NO.test(lower)) && /go ahead|shall i|should i|confirm/i.test(prevAssistant)) {
    const ov = await call("get_care_overview", {});
    const pending = ov?.data?.pending_confirmations ?? [];
    if (pending.length) {
      const p = pending[pending.length - 1];
      const r = await call("confirm_action", { confirmation_id: p.confirmation_id, approve: YES.test(lower), confirmed_by: speaker });
      if (!r.ok) return `I couldn't complete that: ${err(r)}`;
      return YES.test(lower) ? `Done. ${p.summary.replace(/\.$/, "")} — that's saved.` : "Okay, I've cancelled that. Nothing was sent.";
    }
    if (/message|tell|family/i.test(prevAssistant) && YES.test(lower)) {
      const r = await call("notify_family", { message: `${speaker.split(" ")[0]} asked for help arranging transport to tomorrow's appointment.`, severity: "info" });
      return r.ok ? "I've messaged Ravi and Neha about the ride." : `I couldn't message them: ${err(r)}`;
    }
  }

  // 2) Scam guard.
  if (/(someone|a man|a woman|caller|they) (called|phoned|messaged|said|asked)|(sms|message|text|email|whatsapp) (says|said|asking)|otp|anydesk|gift ?card|lottery|kyc|digital arrest/i.test(lower)) {
    const r = await call("assess_scam_risk", { text, channel: /sms|text/.test(lower) ? "sms" : /email/.test(lower) ? "email" : /whatsapp/.test(lower) ? "whatsapp" : "call" });
    if (!r.ok) return `I couldn't check that: ${err(r)}`;
    const d = r.data;
    if (d.verdict === "likely_scam") return `This looks like a scam: it ${d.signals.slice(0, 2).join(" and ")}. Please don't share any code or install anything. I've let your family know.`;
    if (d.verdict === "suspicious") return `That sounds suspicious because it ${d.signals[0]}. Don't share any details; hang up and call the official number yourself. I've told your family.`;
    return d.advice;
  }

  // 3) Symptoms / wellbeing.
  if (/\b(i feel|i'?m feeling|feeling|dizzy|pain|hurts?|fell|fall(en)?|faint|breath|headache|nause|vomit|fever|lonely|sad|can'?t sleep|chest)\b/i.test(lower)) {
    const mood = /lonely|sad|anxious|worried/.exec(lower)?.[0];
    const r = await call("log_wellbeing", { symptoms: text, ...(mood ? { mood } : {}) });
    if (!r.ok) return `I couldn't log that: ${err(r)}`;
    if (r.data.triage === "urgent") return `This could be serious. Please call emergency services now on 112, or press your emergency button. I've alerted Ravi and Neha.`;
    if (r.data.triage === "watch") return `I'm sorry you're not feeling well. I've noted it and let your family know. Please rest, sip some water, and call your doctor if it gets worse.`;
    return "Thank you for telling me. I've noted how you're feeling.";
  }

  // 4) "I took my X" → record dose (double-dose guarded).
  if (/\b(i (just )?took|i'?ve taken|i have taken|taken my|had my)\b/i.test(lower)) {
    const med = medRef(lower);
    if (!med) return "Which medicine did you take?";
    const r = await call("record_dose", { medication: med, recorded_by: speaker });
    if (!r.ok) {
      if (r.error.code === "DOUBLE_DOSE_RISK") return `Please don't take another one. You already took ${r.error.details.medication.name} at ${time(r.error.details.last_taken)}. I didn't record a second dose, and I've let your family know.`;
      if (r.error.code === "AMBIGUOUS_MEDICATION") return `Which one: ${r.error.details.candidates.map((c: any) => c.name).join(" or ")}?`;
      return `I couldn't record that: ${err(r)}`;
    }
    return `Got it, ${r.data.medication} recorded at ${time(r.data.taken_at)}.${r.data.refill_warning ? ` Heads up: ${r.data.refill_warning.split(": ")[1]} Shall I ask the pharmacy for a refill?` : ""}`;
  }

  // 5) "Did I take my X?"
  if (/(did i|have i) (already )?(take|taken|had)|should i take|can i take/i.test(lower)) {
    const med = medRef(lower);
    if (!med) {
      const ov = await call("get_care_overview", {});
      const s = ov.data.medication_schedule;
      const taken = s.filter((x: any) => x.status.startsWith("taken")).map((x: any) => x.medication);
      const pend = s.filter((x: any) => x.status === "due_now" || x.status === "missed").map((x: any) => x.medication);
      return `Today you've taken ${list(taken) || "nothing yet"}.${pend.length ? ` Still due: ${list(pend)}.` : ""}`;
    }
    const r = await call("check_dose_status", { medication: med });
    if (!r.ok) return r.error.code === "AMBIGUOUS_MEDICATION" ? `Which one: ${r.error.details.candidates.map((c: any) => c.name).join(" or ")}?` : `I couldn't check: ${err(r)}`;
    const d = r.data;
    if (!d.safe_to_take_now) return `Yes, you took your ${d.medication.name} at ${time(d.last_taken)}. Don't take another; the next one is at ${time(d.next_scheduled)}.`;
    return `${d.last_taken ? `Your last ${d.medication.name} was ${d.last_taken.startsWith(today()) ? "at" : "on"} ${d.last_taken.startsWith(today()) ? time(d.last_taken) : d.last_taken}.` : `No ${d.medication.name} recorded yet.`} It's okay to take it now${d.medication.with_food ? ", with food" : ""}. Tell me when you have.`;
  }

  // 6) Refills.
  if (/refill|running (low|out)|pharmacy|order (more|my)/i.test(lower)) {
    const f = await call("forecast_refills", { horizon_days: 7 });
    if (!f.ok) return `I couldn't check supplies: ${err(f)}`;
    const named = medRef(lower);
    const target = named ? null : f.data.find((m: any) => m.needs_refill);
    if (!target && !named) return "All your medicines have more than a week's supply.";
    const p = await call("request_refill", { medication: named ?? target.medication });
    if (!p.ok) return `I couldn't prepare that: ${err(p)}`;
    return `${target ? `${target.medication} runs out in about ${target.days_of_supply} days. ` : ""}I can ${p.data.summary.charAt(0).toLowerCase()}${p.data.summary.slice(1, -1)}. Shall I go ahead?`;
  }

  // 7) Appointments.
  if (/appointment|doctor|clinic|check-?up|visit/i.test(lower)) {
    const r = await call("list_appointments", { days: 14 });
    if (!r.ok) return `I couldn't check appointments: ${err(r)}`;
    const a = r.data[0];
    if (!a) return "You have no appointments in the next two weeks.";
    const noRide = a.transport === "NOT ARRANGED";
    return `Your next appointment is ${a.title} with ${a.with_whom ?? "the doctor"} on ${a.starts_at}.${a.notes ? ` Remember: ${a.notes}.` : ""}${noRide ? " No ride is arranged yet. Shall I message the family to ask for one?" : ""}`;
  }

  // 8) Message family.
  if (/(tell|message|ask|call|let) (my )?(son|daughter|ravi|neha|family|kids|children)/i.test(lower)) {
    const r = await call("notify_family", { message: `${speaker}: ${text}`, severity: /urgent|emergency|help/.test(lower) ? "urgent" : "info" });
    return r.ok ? `I've sent that to ${r.data.delivered_to_dashboard_of.map((x: string) => x.split(" ")[0]).join(" and ")}.` : `I couldn't send it: ${err(r)}`;
  }

  // 9) Caregiver digest.
  if (/how (is|was) (mom|mum|maa|ma|asha|she)|digest|summary|report/i.test(lower)) {
    const r = await call("get_family_digest", {});
    if (!r.ok) return `I couldn't build the digest: ${err(r)}`;
    const d = r.data;
    const urgent = d.open_alerts.filter((a: any) => a.severity === "urgent").length;
    return `Today ${d.adherence.taken} doses taken and ${d.adherence.missed} missed${d.missed.length ? ` (${list(d.missed)})` : ""}. ${d.open_alerts.length} open alerts${urgent ? `, ${urgent} urgent` : ""}.${d.refills_needed.length ? ` Refill needed soon: ${list(d.refills_needed.map((x: any) => x.medication))}.` : ""}${d.upcoming_appointments[0] ? ` Next appointment: ${d.upcoming_appointments[0].title} on ${d.upcoming_appointments[0].starts_at}.` : ""}`;
  }

  // 10) Default: today's overview.
  const ov = await call("get_care_overview", {});
  if (!ov.ok) return `I couldn't load today's plan: ${err(ov)}`;
  const s = ov.data.medication_schedule;
  const due = s.filter((x: any) => x.status === "due_now");
  const missed = s.filter((x: any) => x.status === "missed");
  const appt = ov.data.appointments[0];
  return [
    due.length ? `It's time for your ${list(due.map((x: any) => x.medication))}.` : missed.length ? "" : "No medicines are due right now.",
    missed.length ? `You haven't recorded ${list(missed.map((x: any) => `${x.medication} from ${x.time}`))}. Did you take ${missed.length > 1 ? "them" : "it"}?` : "",
    appt ? `You have ${appt.title} at ${time(appt.starts_at)} today.` : "",
  ].filter(Boolean).join(" ") || "Everything is on track today.";
}

function medRef(lower: string): string | null {
  const m = /(levothyroxine|thyroid|metformin|sugar|diabet\w*|amlodipine|bp|blood ?pressure|pressure|atorvastatin|cholesterol|statin)/.exec(lower);
  return m ? m[1] : null;
}
const time = (stamp: string) => stamp?.split(" ")[1] ?? stamp;
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const list = (xs: string[]) => xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
