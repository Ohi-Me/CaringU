// Demo fixture: fictional people, sample data only. Times are relative to "now"
// so the demo always shows a believable state (one missed dose, one low refill,
// an appointment tomorrow with no transport arranged).
import { type DB, tx } from "./db.js";
import { logEvent } from "./family.js";

const HOUR = 3_600_000;

export function resetDemo(db: DB, now: Date) {
  tx(db, () => {
    for (const t of ["dose_log", "refills", "pending_actions", "alert_events", "messages", "alerts", "wellbeing", "appointments", "medications", "people", "audit"])
      db.exec(`DELETE FROM ${t}`);

    const person = db.prepare("INSERT INTO people (id, name, role, relation, phone, priority) VALUES (?,?,?,?,?,?)");
    person.run("p_asha", "Asha Mehra", "elder", "self", null, null);
    person.run("p_ravi", "Ravi", "caregiver", "son", "+91-00000-00001", 1);
    person.run("p_neha", "Neha", "caregiver", "daughter", "+91-00000-00002", 2);

    const med = db.prepare(`INSERT INTO medications (id, name, dose, purpose, times, min_gap_hours, pills_left, pills_per_dose, with_food)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    med.run("med_levo", "Levothyroxine", "50 mcg", "thyroid", JSON.stringify(["07:00"]), 20, 24, 1, 0);
    med.run("med_metf", "Metformin", "500 mg", "diabetes", JSON.stringify(["08:30", "20:30"]), 8, 41, 1, 1);
    med.run("med_amlo", "Amlodipine", "5 mg", "blood pressure", JSON.stringify(["09:00"]), 20, 4, 1, 0);
    med.run("med_ator", "Atorvastatin", "10 mg", "cholesterol", JSON.stringify(["21:30"]), 20, 26, 1, 0);

    // History: the last 3 days, plus today's slots that are already >1h in the past.
    // Yesterday's evening Metformin was missed (a pattern the digest should show).
    const dose = db.prepare("INSERT INTO dose_log (id, medication_id, taken_at, recorded_by) VALUES (?,?,?,?)");
    const meds = db.prepare("SELECT id, times FROM medications").all() as { id: string; times: string }[];
    let n = 0;
    for (let d = 3; d >= 0; d--) {
      for (const m of meds) {
        for (const t of JSON.parse(m.times) as string[]) {
          const [h, mi] = t.split(":").map(Number);
          const at = new Date(now.getTime() - d * 24 * HOUR);
          at.setHours(h, mi + ((n * 7) % 13), 0, 0);
          if (d === 0 && at.getTime() > now.getTime() - HOUR) continue;
          if (d === 1 && m.id === "med_metf" && h >= 20) continue;
          if (d === 0 && m.id === "med_amlo") continue; // today's BP pill not yet recorded
          dose.run(`dose_seed_${n++}`, m.id, at.toISOString(), "seed");
        }
      }
    }

    const appt = db.prepare("INSERT INTO appointments (id, title, starts_at, location, with_whom, transport, notes) VALUES (?,?,?,?,?,?,?)");
    const tomorrow = new Date(now.getTime() + 24 * HOUR); tomorrow.setHours(10, 30, 0, 0);
    const inSix = new Date(now.getTime() + 6 * 24 * HOUR); inSix.setHours(16, 0, 0, 0);
    appt.run("appt_cardio", "Cardiology follow-up", tomorrow.toISOString(), "City Heart Clinic (sample)", "Dr. Iyer (sample)", null, "Bring BP diary and fasting sugar readings");
    appt.run("appt_eye", "Eye check-up", inSix.toISOString(), "Vision Care Centre (sample)", "Dr. Khan (sample)", "Neha will drive", null);

    db.prepare("INSERT INTO alerts (id, at, severity, kind, message) VALUES (?,?,?,?,?)")
      .run("alert_seed_1", new Date(now.getTime() - 14 * HOUR).toISOString(), "warning", "missed_dose", "Metformin 20:30 was not recorded yesterday.");
    logEvent(db, "alert_seed_1", new Date(now.getTime() - 14 * HOUR), "notified", "family dashboard (Ravi, Neha)");
  });
}
