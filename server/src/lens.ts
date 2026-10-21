// Scam Lens: she shows the camera a QR code or a "scan to receive money" request.
// OpenCV (vision service) only decodes the code; these fixed rules decide what it means,
// and the verdict decides what happens next: warn her, alert the family, block the payee.
// No language model is involved in the verdict.
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DB } from "./db.js";
import { raiseAlert } from "./care.js";
import { callVision, PHOTO_DIR, readPhoto } from "./vision.js";

type Row = Record<string, any>;
export type Verdict = "scam" | "suspicious" | "payment" | "link" | "text";
export type CodeFinding = {
  kind: "upi_payment" | "paypal_payment" | "crypto_payment" | "link" | "text";
  verdict: Verdict; reasons: string[];
  payee?: string; payee_name?: string; amount?: string; currency?: string; note?: string; host?: string;
};

// Words scammers use to make a payment look like money coming in.
const BAIT = /\b(receive|claim|refund|cash ?back|prize|reward|lottery|lucky|won|winner|kyc|unblock|bonus|gift|compensation|subsidy)\b/i;
const SHORTENERS = new Set(["bit.ly", "tinyurl.com", "t.co", "is.gd", "cutt.ly", "rb.gy", "shorturl.at", "ow.ly", "tiny.cc", "rebrand.ly"]);
const RISKY_TLDS = /\.(xyz|top|click|loan|work|gq|tk|ml|cf|ga|zip|mov|icu|cyou|rest|buzz)$/i;
// Brands scammers imitate, with the domains that really belong to them.
const BRANDS: Record<string, string[]> = {
  paypal: ["paypal.com", "paypal.me"], sbi: ["onlinesbi.sbi", "sbi.co.in", "onlinesbi.com"], hdfc: ["hdfcbank.com"],
  icici: ["icicibank.com"], axis: ["axisbank.com"], kotak: ["kotak.com"], amazon: ["amazon.in", "amazon.com"],
  google: ["google.com"], apple: ["apple.com"], microsoft: ["microsoft.com"], irctc: ["irctc.co.in"],
  uidai: ["uidai.gov.in"], aadhaar: ["uidai.gov.in"], incometax: ["incometax.gov.in"], epfo: ["epfindia.gov.in"],
  indiapost: ["indiapost.gov.in"], netflix: ["netflix.com"], fedex: ["fedex.com"], dhl: ["dhl.com"],
};
const unLeet = (s: string) => s.toLowerCase().replace(/0/g, "o").replace(/1/g, "l").replace(/3/g, "e").replace(/5/g, "s").replace(/[-_.]/g, "");

function param(q: URLSearchParams, k: string) {
  const v = q.get(k);
  return v ? v.trim().slice(0, 120) : undefined;
}

export function classifyCode(text: string, context = ""): CodeFinding {
  const t = text.trim();
  const baitIn = (s?: string) => !!s && BAIT.test(s);
  // UPI payment codes always TAKE money from whoever scans them.
  if (/^upi:\/\/pay\b/i.test(t)) {
    const q = new URLSearchParams(t.slice(t.indexOf("?") + 1));
    const f: CodeFinding = { kind: "upi_payment", verdict: "payment", reasons: ["Scanning a UPI payment code sends money; it never receives it."],
      payee: param(q, "pa"), payee_name: param(q, "pn"), amount: param(q, "am"), currency: param(q, "cu") ?? "INR", note: param(q, "tn") };
    if (baitIn(f.note) || baitIn(f.payee_name) || baitIn(context)) { f.verdict = "scam"; f.reasons.push("It is presented as money for you (prize, refund, KYC or similar), which is how this scam works."); }
    return f;
  }
  if (/^(bitcoin|ethereum|litecoin|tron|usdt):/i.test(t)) {
    return { kind: "crypto_payment", verdict: "scam", payee: t.split(/[:?]/)[1]?.slice(0, 64),
      reasons: ["It asks for a cryptocurrency payment. Real banks, police and companies never ask for that."] };
  }
  let url: URL | null = null;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(t) ? t : /^[\w-]+(\.[\w-]+)+(\/|$)/.test(t) ? `https://${t}` : ""); } catch { url = null; }
  if (url && /^https?:$/.test(url.protocol)) {
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    // PayPal links that request a payment.
    if ((host === "paypal.me" || host === "paypal.com") && /^\/(paypalme\/)?[^/]+(\/[\d.]+\w*)?\/?$/i.test(url.pathname) && !/^\/(signin|myaccount|home)?\/?$/i.test(url.pathname)) {
      const parts = url.pathname.split("/").filter(Boolean).filter((p) => p.toLowerCase() !== "paypalme");
      const f: CodeFinding = { kind: "paypal_payment", verdict: "payment", host, payee: parts[0], amount: parts[1]?.match(/[\d.]+/)?.[0],
        currency: parts[1]?.match(/[A-Z]{3}$/i)?.[0]?.toUpperCase(), reasons: ["This PayPal link asks you to send money."] };
      if (baitIn(context)) { f.verdict = "scam"; f.reasons.push("It is presented as money for you, but this link only sends money."); }
      return f;
    }
    const reasons: string[] = [];
    let scam = false;
    for (const [brand, official] of Object.entries(BRANDS)) {
      if (!unLeet(host).includes(brand)) continue;
      if (!official.some((d) => host === d || host.endsWith(`.${d}`))) { scam = true; reasons.push(`It pretends to be ${brand === "sbi" ? "SBI" : brand[0].toUpperCase() + brand.slice(1)}, but ${host} is not their website.`); }
      break;
    }
    if (/\.apk(\?|$)/i.test(url.pathname)) { scam = true; reasons.push("It downloads an app file. Scammers use these to take over a phone."); }
    if (url.protocol === "http:") reasons.push("The link is not secure (no https).");
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) reasons.push("It goes to a bare number address instead of a website name.");
    if (host.includes("xn--")) reasons.push("The web address uses look-alike letters.");
    if (SHORTENERS.has(host)) reasons.push("It is a shortened link that hides where it really goes.");
    if (RISKY_TLDS.test(host)) reasons.push(`Addresses ending in ${host.slice(host.lastIndexOf("."))} are often used by scammers.`);
    if (url.username || url.password) reasons.push("The address hides its real destination behind an @ sign.");
    if (BAIT.test(url.pathname + url.search) || baitIn(context)) reasons.push("It promises a prize, refund or KYC update, which is a common scam story.");
    return { kind: "link", host, verdict: scam ? "scam" : reasons.length ? "suspicious" : "link", reasons };
  }
  return { kind: "text", verdict: "text", reasons: [] };
}

const RANK: Record<Verdict, number> = { scam: 4, suspicious: 3, payment: 2, link: 1, text: 0 };
const money = (f: CodeFinding) => f.amount ? `${f.currency === "INR" || !f.currency ? "₹" : `${f.currency} `}${f.amount}` : "money";
const who = (f: CodeFinding) => f.payee_name && f.payee ? `${f.payee_name} (${f.payee})` : f.payee_name ?? f.payee ?? "someone";

export function spokenFor(f: CodeFinding, text: string): string {
  switch (f.verdict) {
    case "scam":
      return f.kind === "link"
        ? `Don't open this. ${f.reasons.join(" ")} I've alerted your family.`
        : `Don't scan or pay this. It would send ${money(f)} to ${who(f)}, it does not give you anything. ${f.reasons.slice(1).join(" ")} I've alerted your family and blocked this payee.`.replace(/\s+/g, " ");
    case "suspicious":
      return `Be careful with this one. It opens ${f.host}. ${f.reasons.join(" ")} Please don't enter any details there. I've let your family know.`;
    case "payment":
      return `This code asks you to pay ${money(f)} to ${who(f)}. Scanning a payment code never gives you money. If you meant to pay them, check with Ravi first.`;
    case "link":
      return `This code opens ${f.host}. I can't tell whether it's safe, so only open it if you were expecting it.`;
    default:
      return `The code just says: "${text.slice(0, 160)}".`;
  }
}

export async function checkCode(db: DB, now: Date, photoId: string, context = "") {
  const form = new FormData();
  form.append("image", new Blob([readPhoto(photoId)]), "photo.jpg");
  const v = await callVision("/scan", form);
  if (v.annotated_jpeg_b64) writeFileSync(join(PHOTO_DIR, `${photoId}_annotated.jpg`), Buffer.from(v.annotated_jpeg_b64, "base64"));
  const evidence = { annotated_image: v.annotated_jpeg_b64 ? `/api/vision/photo/${photoId}/annotated` : null, opencv: v.opencv,
    decoded_by: v.method, views_tried: v.attempts, ms: v.ms, photo_quality: v.quality };
  const codes = (v.codes ?? []) as { text: string }[];
  if (!codes.length) {
    const hint = v.quality?.issues?.length ? ` The photo looks ${v.quality.issues.join(" and ")}.` : "";
    const spoken = v.found_unreadable
      ? `I can see a code but can't read it.${hint} Please hold the phone steady, a little closer, and avoid reflections.`
      : `I couldn't find a QR code in that photo.${hint} Please show the code itself, filling most of the picture.`;
    return { verdict: "none", found_unreadable: !!v.found_unreadable, codes: [], spoken, family_alerted: false, evidence };
  }
  const findings = codes.map((c) => ({ text: c.text, ...classifyCode(c.text, context) }));
  const worst = findings.reduce((a, b) => (RANK[b.verdict] > RANK[a.verdict] ? b : a));
  let alert: Row | null = null;
  const blocked: string[] = [];
  if (worst.verdict === "scam" || worst.verdict === "suspicious") {
    alert = raiseAlert(db, now, worst.verdict === "scam" ? "urgent" : "warning", "scam_code",
      `Scam Lens: she showed a code that ${worst.kind === "link" ? `opens ${worst.host}` : `would pay ${money(worst)} to ${who(worst)}`}. ${worst.reasons.join(" ")} Please call her.`);
    for (const f of findings) if (f.verdict === "scam" && f.payee) {
      db.prepare("INSERT OR REPLACE INTO blocked_payees (payee, reason, at, source) VALUES (?,?,?,?)").run(f.payee.toLowerCase(), f.reasons.join(" "), now.toISOString(), `lens:${photoId}`);
      blocked.push(f.payee);
    }
  }
  const checkId = `lc_${randomUUID().slice(0, 8)}`;
  db.prepare("INSERT INTO lens_checks (id, at, photo_id, verdict, summary, payee) VALUES (?,?,?,?,?,?)")
    .run(checkId, now.toISOString(), photoId, worst.verdict, worst.reasons.join(" ") || worst.kind, worst.payee ?? null);
  return { check_id: checkId, verdict: worst.verdict, codes: findings, spoken: spokenFor(worst, worst.text), blocked_payees: blocked,
    family_alerted: !!alert, notified: alert?.notified ?? [], evidence };
}

export function isBlockedPayee(db: DB, payee: string) {
  return (db.prepare("SELECT * FROM blocked_payees WHERE payee=?").get(payee.toLowerCase()) as Row | undefined) ?? null;
}

export function recentLensChecks(db: DB, limit = 6) {
  return (db.prepare("SELECT * FROM lens_checks ORDER BY at DESC LIMIT ?").all(limit) as Row[])
    .map((c) => ({ at: c.at, verdict: c.verdict, summary: c.summary, payee: c.payee, image: `/api/vision/photo/${c.photo_id}/annotated` }));
}
