// Safe Pay: she can pay a bill by voice, but only the way her family set it up.
// Fixed rules decide whether a payment may go ahead on her yes alone, needs a family member's
// approval, or is refused (blocked payee, scam flagged in the last 30 minutes, amount out of range).
// Money moves only through PayPal (sandbox): from a PayPal account the family linked once (vault),
// or with Ravi approving the order in PayPal himself. The language model never decides.
import { randomUUID } from "node:crypto";
import type { DB } from "./db.js";
import { localStamp, raiseAlert, ToolError } from "./care.js";
import { sendToElder } from "./family.js";

type Row = Record<string, any>;
export type Decision = "her_yes" | "family" | "refuse";
type Confirm = (message: string) => Promise<{ asked: false } | { asked: true; outcome: "approved" | "declined" | "no_answer"; by: string | null }>;

const PP = {
  base: (process.env.PAYPAL_BASE ?? "https://api-m.sandbox.paypal.com").replace(/\/$/, ""),
  id: () => process.env.PAYPAL_CLIENT_ID?.trim() ?? "",
  secret: () => process.env.PAYPAL_CLIENT_SECRET?.trim() ?? "",
  publicUrl: () => (process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 8787}`).replace(/\/$/, ""),
  currency: process.env.PAYPAL_CURRENCY ?? "USD",
};
export const DAILY_LIMIT = Number(process.env.PAY_DAILY_LIMIT ?? 50);
const MAX_PAYMENT = 500;
const SCAM_HOLD_MIN = 30;
export const paypalConfigured = () => !!(PP.id() && PP.secret());
const money = (n: number, c = PP.currency) => `${c === "USD" ? "$" : `${c} `}${n.toFixed(2)}`;

// ---------- PayPal REST (sandbox) ----------
let tokenCache: { token: string; until: number } | null = null;
async function accessToken() {
  if (tokenCache && Date.now() < tokenCache.until) return tokenCache.token;
  const res = await fetch(`${PP.base}/v1/oauth2/token`, {
    method: "POST", body: "grant_type=client_credentials", signal: AbortSignal.timeout(20_000),
    headers: { Authorization: `Basic ${Buffer.from(`${PP.id()}:${PP.secret()}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
  }).catch(() => null);
  const body: any = await res?.json().catch(() => ({}));
  if (!res?.ok || !body?.access_token) throw new ToolError("PAYPAL_AUTH", `PayPal sign-in failed (${res?.status ?? "unreachable"}). Check the sandbox keys.`, true);
  tokenCache = { token: body.access_token, until: Date.now() + (Number(body.expires_in ?? 300) - 60) * 1000 };
  return tokenCache.token;
}

async function paypal(path: string, body?: unknown, requestId?: string, retried = false): Promise<any> {
  if (!paypalConfigured()) throw new ToolError("PAYPAL_NOT_CONFIGURED", "PayPal sandbox keys are not set (PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET). No money was moved.");
  const res = await fetch(`${PP.base}${path}`, {
    method: "POST", body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json", "PayPal-Request-Id": requestId ?? randomUUID() },
  }).catch(() => null);
  const out: any = await res?.json().catch(() => ({}));
  // Permissions changed in the PayPal dashboard only show up in a new access token: sign in again once.
  if (res?.status === 403 && !retried) { tokenCache = null; return paypal(path, body, requestId, true); }
  if (!res?.ok) throw new ToolError("PAYPAL_ERROR", `PayPal ${res?.status ?? "unreachable"}: ${out?.details?.[0]?.issue ?? out?.name ?? "error"}${out?.details?.[0]?.description ? ` (${out.details[0].description})` : ""}. No money was moved.`, (res?.status ?? 500) >= 500);
  return out;
}

const setting = (db: DB, key: string) => (db.prepare("SELECT value FROM settings WHERE key=?").get(key) as Row | undefined)?.value as string | undefined;
const setSetting = (db: DB, key: string, value: string | null) =>
  value === null ? db.prepare("DELETE FROM settings WHERE key=?").run(key) : db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)").run(key, value);

// ---------- payees and the rules ----------
export function listPayees(db: DB) {
  return db.prepare("SELECT id, name, kind, paypal_email, per_payment_limit, added_by FROM payees ORDER BY name").all() as Row[];
}

export function findPayee(db: DB, name: string) {
  const q = name.trim().toLowerCase();
  const all = listPayees(db);
  return all.find((p) => p.name.toLowerCase() === q || p.paypal_email?.toLowerCase() === q)
    ?? all.find((p) => p.name.toLowerCase().includes(q) || q.includes(p.name.toLowerCase()) || q.includes(p.kind)) ?? null;
}

export function addPayee(db: DB, now: Date, a: { name: string; kind: string; paypal_email?: string; per_payment_limit: number }, by: string) {
  if (blockedReason(db, a.name, a.paypal_email)) throw new ToolError("PAYEE_BLOCKED", `${a.name} is blocked because a scam check flagged it.`);
  const id = `payee_${randomUUID().slice(0, 8)}`;
  db.prepare("INSERT INTO payees (id, name, kind, paypal_email, per_payment_limit, added_by, at) VALUES (?,?,?,?,?,?,?)")
    .run(id, a.name, a.kind, a.paypal_email ?? null, a.per_payment_limit, by, now.toISOString());
  return { payee_id: id, ...a, added_by: by };
}

function blockedReason(db: DB, ...keys: (string | null | undefined)[]) {
  for (const k of keys.filter(Boolean) as string[]) {
    const r = db.prepare("SELECT reason FROM blocked_payees WHERE payee=?").get(k.toLowerCase()) as Row | undefined;
    if (r) return r.reason as string;
  }
  return null;
}

/** The whole safety policy for money. Deterministic and explainable. */
export function decide(db: DB, now: Date, payee: Row | null, payeeName: string, amount: number): { decision: Decision; reasons: string[] } {
  const blocked = blockedReason(db, payeeName, payee?.name, payee?.paypal_email);
  if (blocked) return { decision: "refuse", reasons: [`This payee was blocked by a scam check: ${blocked}`] };
  // An unanswered scam alert holds payments until the family has responded to it.
  const scam = db.prepare("SELECT at FROM alerts WHERE kind IN ('scam_guard','scam_code') AND claimed_by IS NULL AND acknowledged_at IS NULL AND at >= ? ORDER BY at DESC LIMIT 1")
    .get(new Date(now.getTime() - SCAM_HOLD_MIN * 60_000).toISOString()) as Row | undefined;
  if (scam) return { decision: "refuse", reasons: [`A scam was flagged at ${localStamp(scam.at).slice(-5)}. Payments wait until the family has answered that alert.`] };
  if (!payee) return { decision: "family", reasons: [`${payeeName} is not one of her approved payees, so a family member must approve.`] };
  const reasons: string[] = [];
  if (amount > payee.per_payment_limit) reasons.push(`${money(amount)} is above the ${money(payee.per_payment_limit)} limit for ${payee.name}.`);
  const day0 = new Date(now); day0.setHours(0, 0, 0, 0);
  const today = (db.prepare("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE status='paid' AND at >= ?").get(day0.toISOString()) as Row).s as number;
  if (today + amount > DAILY_LIMIT) reasons.push(`It would take today's payments to ${money(today + amount)}, over the ${money(DAILY_LIMIT)} daily limit.`);
  return reasons.length ? { decision: "family", reasons } : { decision: "her_yes", reasons: [`${payee.name} is an approved payee and ${money(amount)} is within its limit.`] };
}

// ---------- the flow ----------
function payment(db: DB, id: string) {
  const p = db.prepare("SELECT * FROM payments WHERE id=?").get(id) as Row | undefined;
  if (!p) throw new ToolError("PAYMENT_NOT_FOUND", `No payment ${id}.`);
  return p;
}
const update = (db: DB, now: Date, id: string, fields: Row) =>
  db.prepare(`UPDATE payments SET ${Object.keys(fields).map((k) => `${k}=?`).join(", ")}, updated_at=? WHERE id=?`).run(...Object.values(fields), now.toISOString(), id);

export async function payBill(db: DB, now: Date, a: { payee: string; amount: number; purpose: string }, requestedBy: string, confirm: Confirm) {
  if (!(a.amount > 0) || a.amount > MAX_PAYMENT) throw new ToolError("INVALID_AMOUNT", `Amount must be between 0 and ${money(MAX_PAYMENT)}.`);
  const payee = findPayee(db, a.payee);
  const name = payee?.name ?? a.payee;
  const { decision, reasons } = decide(db, now, payee, name, a.amount);
  const id = `pay_${randomUUID().slice(0, 8)}`;
  const status = decision === "refuse" ? "refused" : decision === "family" ? "awaiting_family" : "awaiting_her_yes";
  db.prepare(`INSERT INTO payments (id, at, payee_id, payee_name, amount, currency, purpose, status, decision_reasons, requested_by, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, now.toISOString(), payee?.id ?? null, name, a.amount, PP.currency, a.purpose, status, reasons.join(" "), requestedBy, now.toISOString());
  const what = `${money(a.amount)} to ${name} for ${a.purpose}`;
  if (decision === "refuse") {
    raiseAlert(db, now, "warning", "payment_refused", `Safe Pay refused a payment of ${what}. ${reasons.join(" ")}`);
    return { payment_id: id, status, reasons, spoken: `I won't pay that. ${reasons.join(" ")} I've let your family know.` };
  }
  if (decision === "family") {
    raiseAlert(db, now, "info", "payment_approval", `Asha asked to pay ${what}. ${reasons.join(" ")} Approve or decline it in Payments.`);
    return { payment_id: id, status, reasons, spoken: `I've asked Ravi to approve paying ${what}. ${reasons[0]} Nothing has been paid yet.` };
  }
  const c = await confirm(`Pay ${what}, from the family's PayPal?`);
  if (!c.asked) {
    // A client that can't ask her directly: the family approves instead, never the model.
    update(db, now, id, { status: "awaiting_family", decision_reasons: `${reasons.join(" ")} Her device could not ask for a yes, so the family must approve.` });
    return { payment_id: id, status: "awaiting_family", spoken: `I've asked Ravi to approve paying ${what}. Nothing has been paid yet.` };
  }
  if (c.outcome !== "approved") {
    update(db, now, id, { status: c.outcome === "declined" ? "cancelled" : "no_answer" });
    return { payment_id: id, status: c.outcome === "declined" ? "cancelled" : "no_answer", spoken: "Okay, I haven't paid anything." };
  }
  update(db, now, id, { approved_by: c.by ?? requestedBy });
  return execute(db, now, id);
}

export async function decidePayment(db: DB, now: Date, id: string, approve: boolean, by: string) {
  const p = payment(db, id);
  if (p.status !== "awaiting_family") throw new ToolError("NOT_WAITING", `This payment is ${p.status.replace(/_/g, " ")}, not waiting for the family.`);
  const again = decide(db, now, p.payee_id ? db.prepare("SELECT * FROM payees WHERE id=?").get(p.payee_id) as Row : null, p.payee_name, p.amount);
  if (again.decision === "refuse") {
    update(db, now, id, { status: "refused", decision_reasons: again.reasons.join(" ") });
    return { payment_id: id, status: "refused", reasons: again.reasons };
  }
  if (!approve) {
    update(db, now, id, { status: "declined", approved_by: by });
    sendToElder(db, now, by.split(" ")[0], `${by.split(" ")[0]} said not to pay ${money(p.amount)} to ${p.payee_name}. Nothing was paid.`);
    return { payment_id: id, status: "declined" };
  }
  update(db, now, id, { approved_by: by });
  return execute(db, now, id);
}

async function execute(db: DB, now: Date, id: string) {
  const p = payment(db, id);
  const payee = p.payee_id ? db.prepare("SELECT * FROM payees WHERE id=?").get(p.payee_id) as Row : null;
  const unit = { reference_id: id, description: `CaringU: ${p.purpose}`.slice(0, 127), amount: { currency_code: p.currency, value: p.amount.toFixed(2) },
    ...(payee?.paypal_email ? { payee: { email_address: payee.paypal_email } } : {}) };
  const vault = setting(db, "paypal_vault_id");
  try {
    if (vault) {
      // The family linked a PayPal account once; small approved bills are charged without a redirect.
      const o = await paypal("/v2/checkout/orders", { intent: "CAPTURE", purchase_units: [unit], payment_source: { paypal: { vault_id: vault } } }, id);
      const cap = o.purchase_units?.[0]?.payments?.captures?.[0];
      if (o.status === "COMPLETED") return paid(db, now, id, o.id, cap?.id ?? null);
      update(db, now, id, { status: "failed", paypal_order_id: o.id ?? null, error: `PayPal order ${o.status ?? "not completed"}` });
      return { payment_id: id, status: "failed", spoken: "PayPal didn't complete that payment, so nothing was paid. I've told your family." };
    }
    // No linked account: Ravi approves this order in PayPal on his phone, then it is captured.
    const o = await paypal("/v2/checkout/orders", { intent: "CAPTURE", purchase_units: [unit], payment_source: { paypal: { experience_context: {
      brand_name: "CaringU", shipping_preference: "NO_SHIPPING", user_action: "PAY_NOW",
      return_url: `${PP.publicUrl()}/api/pay/return`, cancel_url: `${PP.publicUrl()}/api/pay/cancel` } } } }, id);
    const link = (o.links ?? []).find((l: Row) => l.rel === "payer-action" || l.rel === "approve")?.href ?? null;
    update(db, now, id, { status: "awaiting_paypal", paypal_order_id: o.id, approve_url: link });
    raiseAlert(db, now, "info", "payment_approval", `Approved payment of ${money(p.amount)} to ${p.payee_name}: finish it in PayPal from Payments.`);
    return { payment_id: id, status: "awaiting_paypal", paypal_order_id: o.id, approve_url: link,
      spoken: `Ravi will finish paying ${money(p.amount)} to ${p.payee_name} in PayPal. I'll tell you when it's done.` };
  } catch (e) {
    update(db, now, id, { status: "failed", error: (e as Error).message.slice(0, 200) });
    throw e;
  }
}

function paid(db: DB, now: Date, id: string, orderId: string, captureId: string | null) {
  update(db, now, id, { status: "paid", paypal_order_id: orderId, capture_id: captureId });
  const p = payment(db, id);
  sendToElder(db, now, "CaringU", `Paid ${money(p.amount)} to ${p.payee_name} for ${p.purpose}.`);
  return { payment_id: id, status: "paid", paypal_order_id: orderId, capture_id: captureId, spoken: `Done. I've paid ${money(p.amount)} to ${p.payee_name} for ${p.purpose}.` };
}

/** PayPal sends the payer back here after approving an order. */
export async function captureReturned(db: DB, now: Date, orderId: string) {
  const p = db.prepare("SELECT * FROM payments WHERE paypal_order_id=?").get(orderId) as Row | undefined;
  if (!p) throw new ToolError("PAYMENT_NOT_FOUND", "That PayPal order isn't one of ours.");
  if (p.status === "paid") return { payment_id: p.id, status: "paid" };
  const o = await paypal(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, undefined, `${p.id}-capture`);
  if (o.status !== "COMPLETED") throw new ToolError("PAYPAL_ERROR", `PayPal capture returned ${o.status}. No money was moved.`);
  return paid(db, now, p.id, o.id, o.purchase_units?.[0]?.payments?.captures?.[0]?.id ?? null);
}

export async function startLink(db: DB) {
  const t = await paypal("/v3/vault/setup-tokens", { payment_source: { paypal: {
    description: "CaringU: pay Asha's approved bills", usage_pattern: "IMMEDIATE", usage_type: "MERCHANT", customer_type: "CONSUMER",
    permit_multiple_payment_tokens: false,
    experience_context: { brand_name: "CaringU", shipping_preference: "NO_SHIPPING",
      return_url: `${PP.publicUrl()}/api/pay/linked`, cancel_url: `${PP.publicUrl()}/api/pay/cancel` } } } })
    .catch((e: ToolError) => {
      if (/ 403: NOT_AUTHORIZED/.test(e.message))
        throw new ToolError("PAYPAL_VAULT_OFF", "This PayPal app can't save accounts yet. In the PayPal Developer Dashboard, open the app and turn on \"Save payment methods\". Until then, each payment is approved in PayPal.");
      throw e;
    });
  setSetting(db, "paypal_setup_token", t.id);
  return { setup_token_id: t.id, approve_url: (t.links ?? []).find((l: Row) => l.rel === "approve")?.href ?? null };
}

export async function finishLink(db: DB, setupTokenId: string) {
  if (setting(db, "paypal_setup_token") !== setupTokenId) throw new ToolError("UNKNOWN_SETUP_TOKEN", "That PayPal link request isn't the one we started.");
  const t = await paypal("/v3/vault/payment-tokens", { payment_source: { token: { id: setupTokenId, type: "SETUP_TOKEN" } } });
  setSetting(db, "paypal_vault_id", t.id);
  setSetting(db, "paypal_vault_email", t.payment_source?.paypal?.email_address ?? "linked");
  setSetting(db, "paypal_setup_token", null);
  return { linked: true, email: setting(db, "paypal_vault_email") };
}

export function paymentsOverview(db: DB, limit = 10) {
  return {
    paypal: { configured: paypalConfigured(), environment: PP.base.includes("sandbox") ? "sandbox" : "live", linked_account: setting(db, "paypal_vault_email") ?? null },
    daily_limit: DAILY_LIMIT, currency: PP.currency,
    payees: listPayees(db),
    payments: (db.prepare("SELECT * FROM payments ORDER BY at DESC LIMIT ?").all(limit) as Row[]).map((p) => ({
      id: p.id, at: localStamp(p.at), payee: p.payee_name, amount: p.amount, currency: p.currency, purpose: p.purpose, status: p.status,
      reasons: p.decision_reasons, requested_by: p.requested_by, approved_by: p.approved_by, approve_url: p.approve_url, error: p.error,
      paypal_order_id: p.paypal_order_id })),
  };
}
