// Demo fixture: fictional people, sample data only. Times are relative to "now"
// so the demo always shows a believable state (one missed dose, one low refill,
// an appointment tomorrow with no transport arranged).
import { type DB, tx } from "./db.js";
import { logEvent, syncKnownPeople } from "./family.js";

const HOUR = 3_600_000;

export function resetDemo(db: DB, now: Date) {
  tx(db, () => {
    for (const t of ["activity", "strip_checks", "lens_checks", "blocked_payees", "dose_log", "refills", "pending_actions", "alert_events", "messages", "alerts", "wellbeing", "appointments", "medications", "people", "audit"])
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

    // History: the last 6 days (a week for the weekly review), plus today's slots already >1h in the past.
    // Evening Metformin was missed yesterday and 5 days ago (a pattern the review should show);
    // Atorvastatin was missed 4 days ago.
    const dose = db.prepare("INSERT INTO dose_log (id, medication_id, taken_at, recorded_by) VALUES (?,?,?,?)");
    const meds = db.prepare("SELECT id, times FROM medications").all() as { id: string; times: string }[];
    let n = 0;
    for (let d = 6; d >= 0; d--) {
      for (const m of meds) {
        for (const t of JSON.parse(m.times) as string[]) {
          const [h, mi] = t.split(":").map(Number);
          const at = new Date(now.getTime() - d * 24 * HOUR);
          at.setHours(h, mi + ((n * 7) % 13), 0, 0);
          if (d === 0 && at.getTime() > now.getTime() - HOUR) continue;
          if ((d === 1 || d === 5) && m.id === "med_metf" && h >= 20) continue;
          if (d === 4 && m.id === "med_ator") continue;
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

    // The rest of the week, for the weekly review: a scam call Ravi handled, a wellbeing note, and the
    // days she was heard from (one late morning, when the family got the check-in nudge).
    const scamAt = new Date(now.getTime() - 3 * 24 * HOUR);
    db.prepare("INSERT INTO alerts (id, at, severity, kind, message, acknowledged_by, acknowledged_at) VALUES (?,?,?,?,?,?,?)")
      .run("alert_seed_2", scamAt.toISOString(), "urgent", "scam_guard", "Likely scam call: the caller asked for her bank OTP. She was told to hang up.", "Ravi", new Date(scamAt.getTime() + 4 * 60_000).toISOString());
    db.prepare("INSERT INTO wellbeing (id, at, mood, symptoms, red_flag) VALUES (?,?,?,?,0)")
      .run("wb_seed_1", new Date(now.getTime() - 2 * 24 * HOUR).toISOString(), "okay", "knee aching");
    const heard = db.prepare("INSERT INTO activity (day, first_at, last_at, nudged) VALUES (?,?,?,?)");
    for (let d = 6; d >= 1; d--) {
      const day = new Date(now.getTime() - d * 24 * HOUR);
      const first = new Date(day); first.setHours(d === 4 ? 11 : 8, d === 4 ? 40 : 5 + d, 0, 0);
      const last = new Date(day); last.setHours(20, 15, 0, 0);
      const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
      heard.run(key, first.toISOString(), last.toISOString(), d === 4 ? 1 : 0);
    }
  });
  syncKnownPeople(db);
}
