// Safety screen: runs on every user utterance BEFORE the agent (LLM or rules).
// If the deterministic triage or scam check fires, the matching MCP tool is
// called right away (family alerted, state recorded) and the final reply is
// guaranteed to carry the emergency / scam instruction, whatever the agent says.
import type { CallTool, Emit } from "./agent.js";
import { MENTIONS_CONTACT, screenScam, triageText, type ScamResult, type TriageResult } from "./safety.js";
import { EMERGENCY_LINE } from "./care.js";

export interface ScreenOutcome {
  triage: TriageResult;
  scam: ScamResult | null;
  scamChecked: boolean;
  wellbeingLogged: boolean;
  /** When set, the reply is fully determined by the screen and the agent is skipped. */
  terminalReply: string | null;
  /** Facts the agent must know about (already-executed tool calls). */
  notes: string[];
}

export async function runScreen(text: string, speaker: string, call: CallTool, emit: Emit): Promise<ScreenOutcome> {
  const triage = triageText(text);
  // Caregivers describing a symptom are not the patient; the screen only triages Asha's own words.
  const isElder = /^asha/i.test(speaker);
  const scam = MENTIONS_CONTACT.test(text) ? screenScam(text) : null;
  emit({ type: "safety", triage: isElder ? triage.triage : "skipped (caregiver)", triage_signals: triage.signals,
    scam: scam ? scam.verdict : "not a call/message", scam_signals: scam?.signals ?? [], scam_score: scam?.risk_score ?? null });
  const out: ScreenOutcome = { triage, scam, scamChecked: false, wellbeingLogged: false, terminalReply: null, notes: [] };

  if (isElder && triage.triage !== "routine") {
    const r = await call("log_wellbeing", { symptoms: text });
    out.wellbeingLogged = r?.ok === true;
    if (triage.triage === "urgent") {
      out.terminalReply = r?.ok
        ? `${EMERGENCY_LINE} I've alerted ${who(r)}. Stay where you are; if you can, unlock the door.`
        : `${EMERGENCY_LINE} I could not reach your family through CareCircle, so please call 112 yourself now.`;
      return out;
    }
    out.notes.push(`log_wellbeing was already called for this message (triage: watch, signals: ${triage.signals.join(", ")}); family informed. Do not call it again; briefly acknowledge how they feel.`);
  }

  if (scam && scam.verdict !== "no_strong_signals") {
    const r = await call("assess_scam_risk", { text, channel: /sms|text message/i.test(text) ? "sms" : /email/i.test(text) ? "email" : /whatsapp/i.test(text) ? "whatsapp" : "call" });
    out.scamChecked = true;
    if (scam.verdict === "likely_scam") {
      const why = scam.signals.slice(0, 2).join("; ");
      out.terminalReply = `${scam.in_progress ? "Hang up now. " : ""}This looks like a scam. Warning signs: ${why}. Don't share any code or PIN, and don't pay, scan or install anything. Real banks and police never ask for that on the phone.${r?.ok ? ` I've alerted ${who(r)}.` : " I couldn't alert your family, so please call Ravi yourself."}`;
      return out;
    }
    out.notes.push(`assess_scam_risk was already called (verdict: suspicious; signals: ${scam.signals.join("; ")}); family warned. Tell the user not to share codes or pay, and to call back on an official number.`);
  }
  return out;
}

const who = (r: any) => {
  const n: string[] = r?.data?.notified ?? [];
  return n.length ? (n.length === 1 ? n[0] : `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`) : "your family";
};

/** Last line of defence for LLM replies: the safety instruction must be in the reply. */
export function enforce(reply: string, s: ScreenOutcome) {
  if (s.triage.triage === "urgent" && !/\b(112|911|emergency)\b/i.test(reply)) return `${EMERGENCY_LINE} ${reply}`;
  if (s.scam?.verdict === "likely_scam" && !/\b(scam|hang up|don'?t share|do not share)\b/i.test(reply)) return `This looks like a scam; don't share any code or pay anything. ${reply}`;
  return reply;
}
