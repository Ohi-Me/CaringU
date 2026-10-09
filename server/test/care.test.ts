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

test("record_dose decrements stock and the double-dose guard blocks a repeat", () => {
  const db = fresh();
  const r = care.recordDose(db, "bp", "test", at(10));
  assert.equal(r.pills_left, 3);
  assert.match(r.refill_warning!, /Amlodipine/);
  assert.equal(code(() => care.recordDose(db, "bp", "test", at(12))), "DOUBLE_DOSE_RISK");
  assert.equal(care.findMedication(db, "bp").pills_left, 3, "blocked dose must not change stock");
  assert.ok(care.listAlerts(db, false).some((a) => a.kind === "double_dose_blocked"));
  assert.equal(care.doseStatus(db, "bp", at(12)).safe_to_take_now, false);
  assert.equal(care.doseStatus(db, "bp", at(10 + 21)).safe_to_take_now, true);
});

test("Metformin 8h gap: evening dose allowed after morning dose", () => {
  const db = fresh();
  assert.equal(code(() => care.recordDose(db, "metformin", "t", at(12))), "DOUBLE_DOSE_RISK");
  assert.ok(care.recordDose(db, "metformin", "t", at(20, 30)).dose_id);
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
  assert.equal(care.logWellbeing(db, at(10), undefined, "I fell in the bathroom").triage, "urgent");
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
