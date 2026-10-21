// Safe Pay against a mock PayPal sandbox: the rules decide, PayPal only moves approved money.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";

let mock: Server;
const calls: { path: string; body: any }[] = [];
before(async () => {
  const pp = express();
  pp.use(express.json());
  pp.use(express.urlencoded({ extended: false }));
  pp.post("/v1/oauth2/token", (req, res) => {
    assert.match(String(req.headers.authorization), /^Basic /);
    res.json({ access_token: "A21-test", expires_in: 3600 });
  });
  pp.post("/v2/checkout/orders", (req, res) => {
    calls.push({ path: req.path, body: req.body });
    const id = `ORDER${calls.length}`;
    if (req.body.payment_source?.paypal?.vault_id) return res.json({ id, status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: `CAP${calls.length}` }] } }] });
    res.json({ id, status: "PAYER_ACTION_REQUIRED", links: [{ rel: "payer-action", href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }] });
  });
  pp.post("/v2/checkout/orders/:id/capture", (req, res) => res.json({ id: req.params.id, status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "CAPX" }] } }] }));
  pp.post("/v3/vault/setup-tokens", (_req, res) => res.json({ id: "SETUP1", status: "PAYER_ACTION_REQUIRED", links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/agreements/approve?approval_session_id=S1" }] }));
  pp.post("/v3/vault/payment-tokens", (req, res) => {
    assert.equal(req.body.payment_source.token.type, "SETUP_TOKEN");
    res.json({ id: "VAULT1", payment_source: { paypal: { email_address: "ravi-sandbox@example.com" } } });
  });
  await new Promise<void>((r) => { mock = pp.listen(8841, r); });
  Object.assign(process.env, { PAYPAL_BASE: "http://127.0.0.1:8841", PAYPAL_CLIENT_ID: "sb-id", PAYPAL_CLIENT_SECRET: "sb-secret" });
});
after(() => mock.close());

const yes = async () => ({ asked: true as const, outcome: "approved" as const, by: "Asha (test)" });
const at10 = () => { const d = new Date(); d.setHours(10, 0, 0, 0); return d; };
async function fresh() {
  const { openDb } = await import("../src/db.js");
  const { resetDemo } = await import("../src/seed.js");
  const pay = await import("../src/pay.js");
  const db = openDb(":memory:");
  resetDemo(db, at10());
  return { db, pay };
}

test("an approved payee within its limit is paid on her yes; without a linked account Ravi finishes it in PayPal", async () => {
  const { db, pay } = await fresh();
  const r: any = await pay.payBill(db, at10(), { payee: "the pharmacy", amount: 12.5, purpose: "Amlodipine refill" }, "Asha (voice)", yes);
  assert.equal(r.status, "awaiting_paypal");
  assert.match(r.approve_url, /checkoutnow\?token=ORDER/);
  assert.equal(calls.at(-1)!.body.purchase_units[0].amount.value, "12.50");
  const done: any = await pay.captureReturned(db, at10(), r.paypal_order_id);
  assert.equal(done.status, "paid");
});

test("with a linked family PayPal account the payment completes at once", async () => {
  const { db, pay } = await fresh();
  const link: any = await pay.startLink(db);
  assert.match(link.approve_url, /approve/);
  assert.equal((await pay.finishLink(db, "SETUP1")).email, "ravi-sandbox@example.com");
  const r: any = await pay.payBill(db, at10(), { payee: "Sharma Medicals", amount: 12.5, purpose: "refill" }, "Asha (voice)", yes);
  assert.equal(r.status, "paid");
  assert.equal(calls.at(-1)!.body.payment_source.paypal.vault_id, "VAULT1");
  assert.match(r.spoken, /Done\. I've paid \$12\.50 to Sharma Medicals/);
});

test("over the limit or a new payee waits for the family; a declined payment moves no money", async () => {
  const { db, pay } = await fresh();
  const before = calls.length;
  const big: any = await pay.payBill(db, at10(), { payee: "Sharma Medicals", amount: 40, purpose: "three months of medicine" }, "Asha (voice)", yes);
  assert.equal(big.status, "awaiting_family");
  assert.match(big.reasons[0], /above the \$25\.00 limit/);
  const stranger: any = await pay.payBill(db, at10(), { payee: "Lottery Office", amount: 5, purpose: "processing fee" }, "Asha (voice)", yes);
  assert.equal(stranger.status, "awaiting_family");
  assert.equal((await pay.decidePayment(db, at10(), stranger.payment_id, false, "Ravi (son)") as any).status, "declined");
  assert.equal(calls.length, before, "no PayPal order for anything not approved");
  assert.equal((await pay.decidePayment(db, at10(), big.payment_id, true, "Ravi (son)") as any).status, "awaiting_paypal");
});

test("a payee blocked by Scam Lens, or an unanswered scam alert, is refused", async () => {
  const { db, pay } = await fresh();
  const { raiseAlert } = await import("../src/care.js");
  db.prepare("INSERT INTO blocked_payees (payee, reason, at, source) VALUES (?,?,?,?)").run("prize desk", "prize QR code", at10().toISOString(), "lens:test");
  const blocked: any = await pay.payBill(db, at10(), { payee: "Prize Desk", amount: 5, purpose: "fee" }, "Asha (voice)", yes);
  assert.equal(blocked.status, "refused");
  raiseAlert(db, at10(), "urgent", "scam_guard", "OTP call");
  const held: any = await pay.payBill(db, at10(), { payee: "Sharma Medicals", amount: 5, purpose: "refill" }, "Asha (voice)", yes);
  assert.equal(held.status, "refused");
  assert.match(held.reasons[0], /until the family has answered/);
});

test("without sandbox keys nothing is paid and the reason is clear", async () => {
  const { db, pay } = await fresh();
  const saved = process.env.PAYPAL_CLIENT_SECRET;
  delete process.env.PAYPAL_CLIENT_SECRET;
  await assert.rejects(pay.payBill(db, at10(), { payee: "Sharma Medicals", amount: 5, purpose: "refill" }, "Asha (voice)", yes), /sandbox keys are not set/);
  process.env.PAYPAL_CLIENT_SECRET = saved;
});
