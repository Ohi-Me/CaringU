import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { resetDemo } from "../src/seed.js";
import * as care from "../src/care.js";
import { ESCALATION_MINUTES } from "../src/family.js";

const t0 = new Date(2026, 9, 9, 10);
const plus = (min: number) => new Date(t0.getTime() + min * 60_000);
function fresh() { const db = openDb(":memory:"); resetDemo(db, t0); return db; }

test("urgent alert goes to Ravi first, escalates to Neha, then tells her directly", () => {
  const db = fresh();
  const r = care.assessScam(db, t0, "the bank man is still on the line asking for my OTP");
  assert.deepEqual(r.notified, ["Ravi"]);
  const id = r.alert_id!;
  const get = (now: Date) => care.listAlerts(db, false, now).find((a) => a.id === id)!;
  assert.deepEqual(get(plus(ESCALATION_MINUTES - 1)).notified, ["Ravi"]);
  assert.deepEqual(get(plus(ESCALATION_MINUTES)).notified, ["Ravi", "Neha"]);
  assert.equal(care.getAnnouncements(db, plus(ESCALATION_MINUTES)).length, 0);
  const ann = care.getAnnouncements(db, plus(2 * ESCALATION_MINUTES));
  assert.equal(ann.length, 1);
  assert.match(ann[0].text, /112/);
  assert.equal(get(plus(10 * ESCALATION_MINUTES)).escalates_at, null, "ladder ends");
});

test("a caregiver response stops escalation and is spoken on her device", () => {
  const db = fresh();
  const r = care.logWellbeing(db, t0, undefined, "I can't lift my left arm");
  const res = care.respondToAlert(db, plus(1), r.alert_id!, "Ravi (son)", "calling_now", "Stay seated, I'm calling an ambulance") as any;
  assert.equal(res.claimed_by, "Ravi (son)");
  const ann = care.getAnnouncements(db, plus(30));
  assert.equal(ann.length, 1);
  assert.match(ann[0].text, /Ravi is calling you right now.*Message from Ravi: Stay seated/);
  assert.deepEqual(care.listAlerts(db, false, plus(30)).find((a) => a.id === r.alert_id)!.notified, ["Ravi"], "no escalation after response");
  assert.throws(() => care.respondToAlert(db, plus(2), r.alert_id!, "Neha (daughter)", "on_my_way"), /ALREADY|already/);
  care.markAnnouncementsHeard(db, plus(31), ann.map((a) => a.message_id));
  assert.equal(care.getAnnouncements(db, plus(32)).length, 0);
});

test("repeat reports about the same scam update one alert", () => {
  const db = fresh();
  const a = care.assessScam(db, t0, "caller wants my OTP");
  const b = care.assessScam(db, plus(2), "now he says I must install AnyDesk");
  assert.equal(a.alert_id, b.alert_id);
  assert.equal(care.listAlerts(db, false, plus(2)).filter((x) => x.kind === "scam_guard").length, 1);
});
