// Weekly care review for the family. Fixed code gathers the facts from the record; a model
// (NVIDIA Nemotron 3 Ultra on Nebius, or Amazon Bedrock) only turns them into a short, warm
// update. A grounding check rejects any written review that states a number or time that is
// not in the facts, or that gives dosing advice; the family then gets the plain template.
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import type { DB } from "./db.js";
import { careOverview, forecastRefills, listAppointments, localStamp, ymd } from "./care.js";
import { NEBIUS, nemotronComplete } from "./nemotron.js";

type Row = Record<string, any>;
const DAY = 24 * 3_600_000;
const WEEKDAY = (d: Date) => d.toLocaleDateString("en-GB", { weekday: "short" });

export function weeklyFacts(db: DB, now: Date) {
  const days = [];
  const missedByMed: Record<string, number> = {};
  let taken = 0, missed = 0;
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getTime() - i * DAY);
    const o = careOverview(db, now, ymd(d));
    const miss = o.medication_schedule.filter((s: Row) => s.status === "missed");
    for (const s of miss) missedByMed[s.medication] = (missedByMed[s.medication] ?? 0) + 1;
    taken += o.counts.taken; missed += o.counts.missed;
    days.push({ date: o.date, day: WEEKDAY(d), taken: o.counts.taken, missed: o.counts.missed,
      missed_doses: miss.map((s: Row) => `${s.medication} ${s.time}`) });
  }
  const from = new Date(now.getTime() - 6 * DAY); from.setHours(0, 0, 0, 0);
  const since = from.toISOString();
  const extra = db.prepare("SELECT m.name, d.taken_at FROM dose_log d JOIN medications m ON m.id = d.medication_id WHERE d.extra = 1 AND d.taken_at >= ?").all(since) as Row[];
  const alerts = db.prepare("SELECT kind, severity, claimed_by, acknowledged_by, escalation_level FROM alerts WHERE at >= ?").all(since) as Row[];
  const wellbeing = db.prepare("SELECT at, mood, symptoms, red_flag FROM wellbeing WHERE at >= ? ORDER BY at").all(since) as Row[];
  const heard = db.prepare("SELECT day, first_at, nudged FROM activity WHERE day >= ? ORDER BY day").all(ymd(from)) as Row[];
  const moments = (db.prepare("SELECT COUNT(*) n FROM messages WHERE at >= ? AND photo_id IS NOT NULL").get(since) as Row).n as number;
  const blocked = (db.prepare("SELECT COUNT(*) n FROM blocked_payees WHERE at >= ?").get(since) as Row).n as number;
  return {
    period: { from: ymd(from), to: ymd(now), days: 7 },
    medicines: {
      doses_taken: taken, doses_missed: missed,
      adherence_pct: taken + missed ? Math.round((taken / (taken + missed)) * 100) : null,
      missed_by_medicine: missedByMed,
      extra_doses: extra.map((e) => `${e.name} ${localStamp(e.taken_at)}`),
      by_day: days,
    },
    alerts: {
      total: alerts.length,
      urgent: alerts.filter((a) => a.severity === "urgent").length,
      answered_by_family: alerts.filter((a) => a.claimed_by || a.acknowledged_by).length,
      reached_second_contact: alerts.filter((a) => (a.escalation_level ?? 0) >= 2).length,
      scams_stopped: alerts.filter((a) => a.kind === "scam_guard" || a.kind === "scam_code").length,
      payees_blocked: blocked,
    },
    wellbeing: {
      notes: wellbeing.length,
      red_flags: wellbeing.filter((w) => w.red_flag).length,
      mentioned: [...new Set(wellbeing.map((w) => w.symptoms || w.mood).filter(Boolean))].slice(0, 5),
    },
    check_ins: {
      days_heard_from: heard.filter((h) => h.first_at).length,
      days_with_nudge: heard.filter((h) => h.nudged).length,
      first_words_each_day: heard.filter((h) => h.first_at).map((h) => `${h.day.slice(5)} ${localStamp(h.first_at).slice(-5)}`),
    },
    family_moments_shared: moments,
    refills_needed: forecastRefills(db, now, 7).filter((r) => r.needs_refill).map((r) => `${r.medication} (${r.days_of_supply} days left)`),
    coming_up: listAppointments(db, now, undefined, 7).map((a) => `${a.title} ${a.starts_at}${a.transport === "NOT ARRANGED" ? " (no ride arranged)" : ""}`),
  };
}
export type WeeklyFacts = ReturnType<typeof weeklyFacts>;

/** The plain version: always available, always grounded. */
export function templateReview(f: WeeklyFacts) {
  const m = f.medicines;
  const missed = Object.entries(m.missed_by_medicine).map(([k, v]) => `${k} ${v}×`).join(", ");
  const lines = [
    `This week (${f.period.from} to ${f.period.to}) Asha took ${m.doses_taken} of ${m.doses_taken + m.doses_missed} scheduled doses (${m.adherence_pct ?? "-"}%).${missed ? ` Missed: ${missed}.` : ""}${m.extra_doses.length ? ` Extra doses: ${m.extra_doses.join(", ")}.` : ""}`,
    `${f.alerts.total} alerts, ${f.alerts.urgent} urgent; ${f.alerts.scams_stopped} scam attempts stopped${f.alerts.payees_blocked ? `, ${f.alerts.payees_blocked} payees blocked` : ""}.`,
    `She was heard from on ${f.check_ins.days_heard_from} of 7 days${f.check_ins.days_with_nudge ? `; the family was nudged on ${f.check_ins.days_with_nudge}` : ""}.${f.wellbeing.mentioned.length ? ` She mentioned: ${f.wellbeing.mentioned.join("; ")}.` : ""}`,
  ];
  if (f.refills_needed.length) lines.push(`Refills needed: ${f.refills_needed.join(", ")}.`);
  if (f.coming_up.length) lines.push(`Coming up: ${f.coming_up.join("; ")}.`);
  return lines.join(" ");
}

const SYSTEM = `You write a short weekly update about Asha (78, lives alone) for her adult children, Ravi and Neha.
Use ONLY the facts in the JSON you are given. Do not add any number, date, time, medicine or event that is not in it.
Never give medical or dosing advice; if a pattern needs attention, suggest the family ask her doctor or pharmacist.
Write in plain English: a warm 2-4 sentence summary, then "Next steps for the family:" with at most 3 short practical items
(for example arranging a ride, calling the pharmacy, a check-in call). Under 130 words. No headings, no markdown tables.`;

/** Every number or time in the text must appear in the facts; no dosing advice. */
export function groundingCheck(text: string, f: WeeklyFacts) {
  const factText = JSON.stringify(f);
  const factNums = new Set(factText.match(/\d+(?:[.:]\d+)?/g) ?? []);
  ["7", "1", "2", "3", "112"].forEach((n) => factNums.add(n)); // "7 days", list numbering, emergency number
  const WORDS: Record<string, string> = { zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12", once: "1", twice: "2" };
  const spelled = (text.match(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|once|twice)\b/gi) ?? []).map((w) => WORDS[w.toLowerCase()]);
  const nums = [...(text.match(/\d+(?:[.:]\d+)?/g) ?? []), ...spelled];
  const unsupported = [...new Set(nums.filter((n) => !factNums.has(n) && !factNums.has(n.replace(/^0/, ""))))];
  const advice = /\b(safe to|double (the|her|your) dose|increase (the|her) dose|stop taking|skip (the|her) dose|take an extra)\b/i.exec(text)?.[0];
  return { ok: !unsupported.length && !advice, unsupported_numbers: unsupported, dosing_advice: advice ?? null };
}

function provider(): "nebius" | "bedrock" | null {
  if (process.env.AGENT_MODE === "nebius" && process.env.NEBIUS_API_KEY?.trim()) return "nebius";
  if (process.env.AGENT_MODE === "bedrock") return "bedrock";
  return null;
}

export async function writeReview(f: WeeklyFacts) {
  const template = templateReview(f);
  const p = provider();
  if (!p) return { review: template, written_by: "template", reason: "No model configured (AGENT_MODE).", grounding: { ok: true } };
  const user = `Facts (JSON):\n${JSON.stringify(f)}`;
  const t0 = performance.now();
  let text = "", model = "", usage: Record<string, number | undefined> = {};
  try {
    if (p === "nebius") {
      const out = await nemotronComplete(NEBIUS.reason, SYSTEM, user, 900);
      text = out.text; model = NEBIUS.reason; usage = { input_tokens: out.usage?.prompt_tokens, output_tokens: out.usage?.completion_tokens };
    } else {
      model = process.env.BEDROCK_MODEL_ID ?? "amazon.nova-pro-v1:0";
      const br = new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? "us-east-1" });
      const out = await br.send(new ConverseCommand({ modelId: model, system: [{ text: SYSTEM }], messages: [{ role: "user", content: [{ text: user }] }],
        inferenceConfig: { maxTokens: 500, temperature: 0.2 } }));
      text = (out.output?.message?.content ?? []).map((c) => c.text ?? "").join(" ").trim();
      usage = { input_tokens: out.usage?.inputTokens, output_tokens: out.usage?.outputTokens };
    }
  } catch (e: any) {
    return { review: template, written_by: "template", reason: `${p} unavailable: ${String(e?.message ?? e).slice(0, 160)}`, grounding: { ok: true } };
  }
  const ms = Math.round(performance.now() - t0);
  const grounding = groundingCheck(text, f);
  if (!text || !grounding.ok)
    return { review: template, written_by: "template", reason: "The written review failed the grounding check, so the plain version is shown.",
      rejected: text, model, provider: p, usage, ms, grounding };
  return { review: text, written_by: p, model, usage, ms, grounding };
}
