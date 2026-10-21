// Scam Lens rules: what a decoded QR code means. No camera or model involved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyCode, spokenFor } from "../src/lens.js";

test("UPI payment code framed as a prize is a scam; a plain one is a payment", () => {
  const prize = classifyCode("upi://pay?pa=prize-desk@okaxis&pn=Prize%20Desk&am=5000&cu=INR&tn=Receive%20your%20prize");
  assert.equal(prize.verdict, "scam");
  assert.equal(prize.payee, "prize-desk@okaxis");
  assert.equal(prize.amount, "5000");
  assert.match(spokenFor(prize, ""), /would send ₹5000 to Prize Desk \(prize-desk@okaxis\)/);
  const shop = classifyCode("upi://pay?pa=sharma.medicals@okicici&pn=Sharma%20Medicals&am=420");
  assert.equal(shop.verdict, "payment");
  assert.match(spokenFor(shop, ""), /never gives you money/);
  // Her own words can reveal the story: "he said scan to get my refund".
  assert.equal(classifyCode("upi://pay?pa=x@ybl&am=10", "the man said scan this to get my refund").verdict, "scam");
});

test("look-alike bank links, app downloads and crypto requests are scams", () => {
  assert.equal(classifyCode("https://sbi-kyc-update.xyz/login").verdict, "scam");
  assert.equal(classifyCode("https://paypa1-secure.com/verify").verdict, "scam");
  assert.equal(classifyCode("https://example.com/files/PMKisan.apk").verdict, "scam");
  assert.equal(classifyCode("bitcoin:bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh?amount=0.01").verdict, "scam");
});

test("real brand sites are not flagged; risky links are suspicious; text is read out", () => {
  assert.equal(classifyCode("https://www.onlinesbi.sbi/").verdict, "link");
  assert.equal(classifyCode("https://www.paypal.com/signin").verdict, "link");
  assert.equal(classifyCode("http://bit.ly/3abcd").verdict, "suspicious");
  assert.equal(classifyCode("http://192.168.4.20/pay").verdict, "suspicious");
  const wifi = classifyCode("Table 4 - Wi-Fi password at the counter");
  assert.equal(wifi.verdict, "text");
});

test("PayPal payment links are payments, and scams when sold as money for her", () => {
  const p = classifyCode("https://paypal.me/helpdesk/250USD");
  assert.equal(p.kind, "paypal_payment");
  assert.equal(p.verdict, "payment");
  assert.equal(p.payee, "helpdesk");
  assert.equal(p.amount, "250");
  assert.equal(classifyCode("https://paypal.me/helpdesk/250", "they said I'll receive a refund").verdict, "scam");
});
