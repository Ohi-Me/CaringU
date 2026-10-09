// Held-out evaluation (sets frozen before the safety changes; see eval/*.json).
//  1. Scam detector: precision / recall / false-positive rate on labeled messages.
//  2. Symptom triage: confusion matrix urgent / watch / routine.
//  3. End-to-end conversations through the running agent (needs the server).
// Usage: npm run heldout [-- --label baseline]   -> docs/heldout-<label>-<mode>.md
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { openDb } from "../src/db.js";
import { resetDemo } from "../src/seed.js";
import * as care from "../src/care.js";

const BASE = process.env.BASE_URL ?? "http://localhost:8787";
const label = process.argv.includes("--label") ? process.argv[process.argv.indexOf("--label") + 1] : "current";
const load = (f: string) => JSON.parse(readFileSync(new URL(`../eval/${f}`, import.meta.url), "utf8"));
const out: string[] = [];
const log = (s = "") => { console.log(s); out.push(s); };

// ---------- 1. scam detector ----------
const db = openDb(":memory:");
const now = new Date(2026, 9, 9, 10);
resetDemo(db, now);
const scam = load("scam-set.json").items as { label: "scam" | "benign"; text: string }[];
let tp = 0, fp = 0, fn = 0, tn = 0;
const scamMiss: string[] = [];
for (const it of scam) {
  const r = care.assessScam(db, now, it.text);
  const flagged = r.verdict !== "no_strong_signals";
  if (it.label === "scam") { if (flagged) tp++; else { fn++; scamMiss.push(`MISSED scam (score ${r.risk_score}): ${it.text}`); } }
  else { if (flagged) { fp++; scamMiss.push(`FALSE ALARM (${r.verdict}, ${r.risk_score}): ${it.text}`); } else tn++; }
}
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "n/a");
log(`## 1. Scam detector (${scam.length} labeled messages)`);
log("");
log(`Recall ${pct(tp, tp + fn)} (${tp}/${tp + fn}) · precision ${pct(tp, tp + fp)} · false-positive rate on benign look-alikes ${pct(fp, fp + tn)} (${fp}/${fp + tn})`);
log("");
scamMiss.forEach((m) => log(`- ${m}`));

// ---------- 2. triage ----------
const tri = load("triage-set.json").items as { label: "urgent" | "watch" | "routine"; text: string }[];
const L = ["urgent", "watch", "routine"] as const;
const cm: Record<string, Record<string, number>> = Object.fromEntries(L.map((a) => [a, Object.fromEntries(L.map((b) => [b, 0]))]));
const triMiss: string[] = [];
for (const it of tri) {
  const got = care.logWellbeing(db, now, undefined, it.text).triage as string;
  cm[it.label][got]++;
  if (got !== it.label) triMiss.push(`expected ${it.label}, got ${got}: ${it.text}`);
}
const correct = L.reduce((s, l) => s + cm[l][l], 0);
log("");
log(`## 2. Symptom triage (${tri.length} labeled statements)`);
log("");
log(`Accuracy ${pct(correct, tri.length)} · urgent recall ${pct(cm.urgent.urgent, L.reduce((s, l) => s + cm.urgent[l], 0))} · false emergencies on routine ${cm.routine.urgent}/${L.reduce((s, l) => s + cm.routine[l], 0)}`);
log("");
log("| expected \\ got | urgent | watch | routine |");
log("|---|---|---|---|");
L.forEach((a) => log(`| ${a} | ${L.map((b) => cm[a][b]).join(" | ")} |`));
log("");
triMiss.forEach((m) => log(`- ${m}`));

// ---------- 3. conversations ----------
type C = { cat: string; say: string; setup?: string[]; speaker?: string; requires?: string[]; forbids?: string[]; reply?: string; reply_not?: string };
const convs = load("heldout-conversations.json").cases as C[];
let mode = "offline";
const conv: string[] = [];
let pass = 0;
async function chat(history: { role: string; text: string }[], speaker?: string) {
  const res = await fetch(`${BASE}/api/agent/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ history, speaker }) });
  const ev = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
  return { tools: ev.filter((e) => e.type === "tool_call").map((e) => e.name as string), final: ev.find((e) => e.type === "final") ?? ev.find((e) => e.type === "error") ?? {} };
}
const reset = () => fetch(`${BASE}/api/reset`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ time: "10:00" }) });
try {
  for (const c of convs) {
    await reset();
    const h: { role: string; text: string }[] = [];
    for (const s of c.setup ?? []) { h.push({ role: "user", text: s }); const r = await chat(h, c.speaker); h.push({ role: "assistant", text: r.final.text ?? "" }); }
    h.push({ role: "user", text: c.say });
    const r = await chat(h, c.speaker);
    mode = r.final.mode ?? mode;
    const reply: string = r.final.text ?? r.final.message ?? "";
    const p = [
      ...(c.requires ?? []).filter((t) => !r.tools.includes(t)).map((t) => `missing ${t}`),
      ...(c.forbids ?? []).filter((t) => r.tools.includes(t)).map((t) => `called ${t}`),
      ...(c.reply && !new RegExp(c.reply, "i").test(reply) ? ["reply lacks expected content"] : []),
      ...(c.reply_not && new RegExp(c.reply_not, "i").test(reply) ? ["reply contains forbidden content"] : []),
    ];
    if (!p.length) pass++;
    conv.push(`| ${c.cat} | ${c.setup ? `(after "${c.setup.join(" / ")}") ` : ""}${c.say} | ${r.tools.join(", ") || "—"} | ${p.length ? `FAIL: ${p.join("; ")}` : "PASS"} | ${reply.replace(/\|/g, "/").slice(0, 150)} |`);
  }
  await fetch(`${BASE}/api/reset`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  log("");
  log(`## 3. Held-out conversations (${mode} agent): ${pass}/${convs.length} passed`);
  log("");
  log("| Category | Request | Tools | Result | Reply |");
  log("|---|---|---|---|---|");
  conv.forEach((l) => log(l));
} catch (e) {
  log(`\n## 3. Held-out conversations: skipped (server not reachable at ${BASE}: ${e})`);
}

mkdirSync(new URL("../../docs/", import.meta.url), { recursive: true });
const file = new URL(`../../docs/heldout-${label}-${mode}.md`, import.meta.url);
writeFileSync(file, `# Held-out evaluation: ${label} (${mode} agent)\n\nGenerated ${new Date().toISOString().slice(0, 16)} UTC. Sets in server/eval/ were frozen before the safety rework.\n\n${out.join("\n")}\n`);
console.log(`\nwrote ${file.pathname}`);
