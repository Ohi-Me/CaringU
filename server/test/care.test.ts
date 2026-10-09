import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { resetDemo } from "../src/seed.js";
import * as care from "../src/care.js";

// Fixed local clock: 10:00, so 07:00 & 08:30 doses are seeded, Amlodipine 09:00 is not.
const at = (h: number, m = 0) => new Date(2026, 9, 9, h, m);
function fresh() { const db = openDb(":memory:"); resetDemo(db, at(10)); return db; }
const code = (fn: () => unknown) => { try { fn(); return null; } catch (e: any) { return e.code; } };

test("overview shows today's statuses from seed", () => {
  const o = care.careOverview(fresh(), at(10));
  const by = Object.fromEntries(o.medication_schedule.map((s) => [`${s.medication} ${s.time}`, s.status]));
  assert.equal(by["Levothyroxine 07:00"], "taken");
  assert.equal(by["Metformin 08:30"], "taken");
  assert.equal(by["Amlodipine 09:00"], "due_now");
  assert.equal(by["Atorvastatin 21:30"], "upcoming");
});

test("missed after 2h grace", () => {
  const o = care.careOverview(fresh(), at(11, 30));
  assert.equal(o.medication_schedule.find((s) => s.medication === "Amlodipine")!.status, "missed");
});

test("synonyms resolve: BP pill -> Amlodipine, sugar -> Metformin", () => {
  const db = fresh();
  assert.equal(care.findMedication(db, "my BP pill").name, "Amlodipine");
  assert.equal(care.findMedication(db, "sugar tablet").name, "Metformin");
  assert.equal(code(() => care.findMedication(db, "pill")), "AMBIGUOUS_MEDICATION");
  assert.equal(code(() => care.findMedication(db, "aspirin")), "MEDICATION_NOT_FOUND");
});

test("record_dose: duplicate within gap is NOT silently recorded; user must confirm an extra dose", () => {
  const db = fresh();
  const r = care.recordDose(db, "bp", "test", at(10)) as any;
  assert.equal(r.status, "recorded");
  assert.equal(r.pills_left, 3);
  assert.match(r.refill_warning, /Amlodipine/);
  const dup = care.recordDose(db, "bp", "test", at(12)) as any;
  assert.equal(dup.status, "possible_duplicate");
  assert.equal(dup.changed, false);
  assert.equal(care.findMedication(db, "bp").pills_left, 3, "unconfirmed duplicate must not change stock");
  const extra = care.recordDose(db, "bp", "test", at(12), { extra_dose_confirmed: true }) as any;
  assert.equal(extra.status, "extra_dose_recorded");
  assert.match(extra.extra_dose.guidance_for_user, /pharmacist|doctor/);
  assert.ok(care.listAlerts(db, false).some((a) => a.kind === "extra_dose" && a.severity === "urgent"));
});

test("record_dose: same dose reported again with a time is a no-op; times are validated", () => {
  const db = fresh();
  care.recordDose(db, "bp", "t", at(10), { taken_at: "09:05" });
  const again = care.recordDose(db, "bp", "t", at(10), { taken_at: "09:00" }) as any;
  assert.equal(again.status, "already_recorded");
  assert.equal(code(() => care.recordDose(db, "thyroid", "t", at(10), { taken_at: "11:00" })), "TAKEN_AT_IN_FUTURE");
  assert.equal(code(() => care.recordDose(db, "thyroid", "t", at(10), { taken_at: "2026-10-01 09:00" })), "TAKEN_AT_TOO_OLD");
});

test("dose status never certifies safety", () => {
  const db = fresh();
  const s = care.doseStatus(db, "bp", at(10)) as any;
  assert.equal("safe_to_take_now" in s, false);
  assert.equal(s.recorded_within_min_gap, false);
  assert.match(s.basis, /only/);
  assert.doesNotMatch(s.guidance, /safe to take/i);
  assert.equal((care.doseStatus(db, "thyroid", at(10)) as any).recorded_within_min_gap, true);
});

test("Metformin 8h gap: evening dose allowed after morning dose", () => {
  const db = fresh();
  assert.equal((care.recordDose(db, "metformin", "t", at(12)) as any).status, "possible_duplicate");
  assert.equal((care.recordDose(db, "metformin", "t", at(20, 30)) as any).status, "recorded");
});

test("refill: proposal does nothing until confirmed; confirm is idempotent", () => {
  const db = fresh();
  assert.equal(care.forecastRefills(db, at(10))[0].medication, "Amlodipine");
  const p = care.proposeRefill(db, at(10), "Amlodipine");
  assert.equal(p.status, "awaiting_confirmation");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM refills").get()!.n, 0);
  assert.equal(care.proposeRefill(db, at(10), "Amlodipine").duplicate_of_existing_request, true);
  const done = care.resolvePending(db, at(10), p.confirmation_id, true, "Ravi");
  assert.equal(done.status, "done");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM refills").get()!.n, 1);
  assert.equal(code(() => care.resolvePending(db, at(10), p.confirmation_id, true, "Ravi")), "ALREADY_RESOLVED");
});

test("declined proposal changes nothing", () => {
  const db = fresh();
  const p = care.proposeCancelAppointment(db, at(10), "appt_cardio");
  care.resolvePending(db, at(10), p.confirmation_id, false, "Asha");
  assert.equal(care.listAppointments(db, at(10)).length, 2);
});

test("appointment scheduling validates and reports clashes", () => {
  const db = fresh();
  assert.equal(code(() => care.proposeAppointment(db, at(10), { title: "x", starts_at: "tomorrow" })), "INVALID_DATETIME");
  assert.equal(code(() => care.proposeAppointment(db, at(10), { title: "x", starts_at: "2026-10-01 10:00" })), "IN_THE_PAST");
  const p = care.proposeAppointment(db, at(10), { title: "Blood test", starts_at: "2026-10-10 11:00" });
  assert.equal(p.conflicts_within_2h.length, 1);
  care.resolvePending(db, at(10), p.confirmation_id, true, "Neha");
  assert.equal(care.listAppointments(db, at(10)).length, 3);
});

test("red-flag symptoms escalate urgently; mild ones are watch", () => {
  const db = fresh();
  assert.equal(care.logWellbeing(db, at(10), undefined, "I have chest pain").triage, "urgent");
  assert.equal(care.logWellbeing(db, at(10), undefined, "I fell in the bathroom and can't get up").triage, "urgent");
  assert.equal(care.logWellbeing(db, at(10), undefined, "I fell in the bathroom").triage, "watch");
  assert.equal(care.logWellbeing(db, at(10), undefined, "a bit dizzy").triage, "watch");
  assert.equal(care.logWellbeing(db, at(10), "happy", "slept well").triage, "routine");
  assert.equal(care.listAlerts(db, false).filter((a) => a.severity === "urgent").length, 2);
});

test("scam guard", () => {
  const db = fresh();
  assert.equal(care.assessScam(db, at(10), "Bank officer: your account will be blocked, share the OTP and install AnyDesk").verdict, "likely_scam");
  assert.equal(care.assessScam(db, at(10), "Customs officer says your parcel seized, digital arrest, pay by gift card").verdict, "likely_scam");
  assert.equal(care.assessScam(db, at(10), "Neha called to say she will visit Sunday").verdict, "no_strong_signals");
});

test("digest and alert acknowledgement", () => {
  const db = fresh();
  const d = care.familyDigest(db, at(11, 30));
  assert.deepEqual(d.missed, ["Amlodipine 09:00"]);
  assert.equal(d.refills_needed[0].medication, "Amlodipine");
  care.acknowledgeAlert(db, at(10), "alert_seed_1", "Ravi");
  assert.equal(code(() => care.acknowledgeAlert(db, at(10), "alert_seed_1", "Ravi")), "ALERT_NOT_FOUND");
});
