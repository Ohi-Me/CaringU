// Weekly review: facts come from the record; a written review that invents a number is rejected.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { openDb } from "../src/db.js";
import { resetDemo } from "../src/seed.js";

let mock: Server;
let reply = "";
before(async () => {
  const app = express();
  app.use(express.json());
  app.post("/v1/chat/completions", (req, res) => res.json({ model: req.body.model, choices: [{ message: { content: reply } }], usage: { prompt_tokens: 900, completion_tokens: 120 } }));
  await new Promise<void>((r) => { mock = app.listen(8821, r); });
  Object.assign(process.env, { AGENT_MODE: "nebius", NEBIUS_API_KEY: "test-key", NEBIUS_BASE_URL: "http://127.0.0.1:8821/v1" });
});
after(() => mock.close());

const at10 = () => { const d = new Date(); d.setHours(10, 0, 0, 0); return d; };

test("weekly facts reflect the week in the record", async () => {
  const { weeklyFacts, templateReview } = await import("../src/review.js");
  const db = openDb(":memory:");
  const now = at10();
  resetDemo(db, now);
  const f = weeklyFacts(db, now);
  assert.equal(f.medicines.missed_by_medicine["Metformin"], 2);
  assert.equal(f.medicines.missed_by_medicine["Atorvastatin"], 1);
  assert.equal(f.alerts.scams_stopped, 1);
  assert.equal(f.check_ins.days_heard_from, 6);
  assert.equal(f.check_ins.days_with_nudge, 1);
  assert.ok(f.refills_needed.some((r) => r.startsWith("Amlodipine")));
  assert.match(templateReview(f), /Metformin 2×/);
});

test("grounding check: invented numbers and dosing advice are caught", async () => {
  const { weeklyFacts, groundingCheck } = await import("../src/review.js");
  const db = openDb(":memory:");
  resetDemo(db, at10());
  const f = weeklyFacts(db, at10());
  assert.deepEqual(groundingCheck("She missed 99 doses.", f).unsupported_numbers, ["99"]);
  assert.ok(groundingCheck("It is safe to double the dose tomorrow.", f).dosing_advice);
  assert.equal(groundingCheck(`She missed Metformin 2 times; ${f.alerts.scams_stopped} scam call was stopped.`, f).ok, true);
});

test("Nemotron Ultra writes the review; an invented number falls back to the plain version", async () => {
  const { weeklyFacts, writeReview } = await import("../src/review.js");
  const db = openDb(":memory:");
  resetDemo(db, at10());
  const f = weeklyFacts(db, at10());
  reply = "<think>check facts</think>Asha had a steady week and missed Metformin 2 times in the evening. Next steps for the family: arrange a ride to cardiology.";
  const good = await writeReview(f);
  assert.equal(good.written_by, "nebius");
  assert.match(String(good.model), /Ultra/);
  assert.doesNotMatch(good.review, /think/);
  reply = "Asha missed 87 doses this week."; // 87 cannot come from the facts (dates there only go up to 31)
  const bad = await writeReview(f);
  assert.equal(bad.written_by, "template");
  assert.deepEqual(bad.grounding.unsupported_numbers, ["87"]);
});

test("grounding check also reads numbers written as words", async () => {
  const { weeklyFacts, groundingCheck } = await import("../src/review.js");
  const db = openDb(":memory:");
  resetDemo(db, at10());
  const f = weeklyFacts(db, at10());
  assert.equal(groundingCheck("She missed three doses.", f).ok, true);
  // Dates in the facts contain day numbers, so pick a spelled number that is not among them today.
  const tokens = new Set(JSON.stringify(f).match(/d+(?:[.:]d+)?/g));
  const [word, digit] = ([["eleven", "11"], ["twelve", "12"], ["nine", "9"], ["eight", "8"]] as const).find(([, d]) => !tokens.has(d))!;
  assert.deepEqual(groundingCheck(`She missed ${word} doses.`, f).unsupported_numbers, [digit]);
});
