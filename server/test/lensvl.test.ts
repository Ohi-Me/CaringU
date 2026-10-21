// Scam Lens + Nemotron VL (Nebius mode), with the vision service and Token Factory mocked:
// the words the model reads are evidence for the fixed rules, never the verdict itself.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let servers: Server[] = [];
let codes: { text: string }[] = [];
let words = "";
let visionCalls = 0;
before(async () => {
  const vision = express();
  vision.post("/scan", (_req, res) => res.json({ codes, method: "raw/standard", attempts: 1, quality: { issues: [] }, opencv: "5.0.0", annotated_jpeg_b64: null }));
  const tf = express();
  tf.use(express.json({ limit: "5mb" }));
  tf.post("/v1/chat/completions", (req, res) => {
    visionCalls++;
    assert.equal(req.body.messages[0].content[1].type, "image_url");
    res.json({ choices: [{ message: { content: words } }], usage: { prompt_tokens: 700, completion_tokens: 30 } });
  });
  await new Promise<void>((r) => servers.push(vision.listen(8831, r)));
  await new Promise<void>((r) => servers.push(tf.listen(8832, r)));
  Object.assign(process.env, { AGENT_MODE: "nebius", NEBIUS_API_KEY: "test-key", NEBIUS_BASE_URL: "http://127.0.0.1:8832/v1",
    VISION_URL: "http://127.0.0.1:8831", PHOTO_DIR: mkdtempSync(join(tmpdir(), "cc-vl-")) });
});
after(() => servers.forEach((s) => s.close()));

async function setup() {
  const { openDb } = await import("../src/db.js");
  const { resetDemo } = await import("../src/seed.js");
  const { savePhoto } = await import("../src/vision.js");
  const { checkCode } = await import("../src/lens.js");
  const db = openDb(":memory:");
  resetDemo(db, new Date());
  const photo = savePhoto(Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(200)]));
  return { db, photo, checkCode };
}

test("the printed words turn a plain payment code into a scam", async () => {
  const { db, photo, checkCode } = await setup();
  codes = [{ text: "upi://pay?pa=desk@ybl&pn=Desk&am=2000&cu=INR" }];
  words = "CONGRATULATIONS! You won Rs 2,000 cashback. Scan to RECEIVE now";
  const r: any = await checkCode(db, new Date(), photo);
  assert.equal(r.verdict, "scam");
  assert.equal(r.evidence.words_read.model, "nvidia/Nemotron-3.5-Super-VL");
  assert.deepEqual(r.blocked_payees, ["desk@ybl"]);
});

test("no code, but the message the model read is screened by the fixed scam rules", async () => {
  const { db, photo, checkCode } = await setup();
  codes = [];
  words = "Dear customer, your bank account is blocked. Update KYC today: share the OTP sent to your phone with our officer.";
  const r: any = await checkCode(db, new Date(), photo);
  assert.equal(r.verdict, "scam");
  assert.match(r.spoken, /Don't reply, pay, or call/);
});

test("a normal bill stays a payment reminder", async () => {
  const { db, photo, checkCode } = await setup();
  codes = [{ text: "upi://pay?pa=sharma.medicals@okicici&pn=Sharma%20Medicals&am=420" }];
  words = "Sharma Medicals Bill 2291 Rs 420 Pay by UPI";
  const r: any = await checkCode(db, new Date(), photo);
  assert.equal(r.verdict, "payment");
  assert.ok(visionCalls >= 3);
});
