// End-to-end strip check: CareCircle MCP tools -> Python OpenCV 5 service -> reconciliation.
// Uses SYNTHETIC strip photos with known counts. Skipped if the Python venv is missing.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const VISION_DIR = resolve("../vision");
const PY = join(VISION_DIR, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const skip = !existsSync(PY) && "Python vision venv not installed";
const NODE_PORT = 8803, VISION_PORT = 8791;
const BASE = `http://127.0.0.1:${NODE_PORT}`;
const procs: ChildProcess[] = [];
let imgDir = "";

async function waitFor(url: string) {
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`not up: ${url}`);
}

before(async () => {
  if (skip) return;
  imgDir = mkdtempSync(join(tmpdir(), "cc-strips-"));
  // Synthetic photos: reference (10 pills) and inspection photos with 10, 9 and 7 pills.
  execFileSync(PY, ["-c", `
import sys, cv2
sys.path.insert(0, ".")
from carecircle_vision.synth import StripSpec, draw_strip, photograph
d = sys.argv[1]
def save(name, full, seed, tilt):
    img = draw_strip(StripSpec(rows=2, cols=5, seed=1, label="AMLO 5mg", full=full))[0]
    cv2.imwrite(f"{d}/{name}.jpg", photograph(img, seed=seed, tilt=tilt, background="plain" if tilt == 0 else "random")[0])
save("ref", [True]*10, 1, 0)
save("p10", [True]*10, 11, 0.12)
save("p9", [False] + [True]*9, 12, 0.12)
save("p7", [False]*3 + [True]*7, 13, 0.12)
`, imgDir], { cwd: VISION_DIR });
  const refs = mkdtempSync(join(tmpdir(), "cc-refs-"));
  procs.push(spawn(PY, ["-m", "uvicorn", "carecircle_vision.app:app", "--port", String(VISION_PORT)], {
    cwd: VISION_DIR, env: { ...process.env, VISION_REFS_DIR: refs }, stdio: "ignore" }));
  procs.push(spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    env: { ...process.env, PORT: String(NODE_PORT), DB_PATH: ":memory:", WEB_DIST: "__none__", AGENT_MODE: "rules",
      VISION_URL: `http://127.0.0.1:${VISION_PORT}`, PHOTO_DIR: mkdtempSync(join(tmpdir(), "cc-photos-")) }, stdio: "ignore" }));
  await waitFor(`http://127.0.0.1:${VISION_PORT}/health`);
  await waitFor(`${BASE}/api/health`);
  await fetch(`${BASE}/api/reset`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ time: "10:00" }) });
});
after(() => procs.forEach((p) => p.kill()));

async function upload(name: string) {
  const r = await fetch(`${BASE}/api/vision/photo`, { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: readFileSync(join(imgDir, `${name}.jpg`)) });
  return (await r.json()).photo_id as string;
}

test("strip check: register, baseline, unrecorded dose (asked, then recorded), double dose alert", { skip }, async () => {
  let answer = true;
  const asked: string[] = [];
  const c = new Client({ name: "device", version: "1" }, { capabilities: { elicitation: { form: {} } } });
  c.setRequestHandler(ElicitRequestSchema, async (req) => {
    asked.push((req.params as any).message);
    return { action: "accept", content: { approve: answer, answered_by: "Asha (test)" } } as any;
  });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
  const call = async (name: string, args: Record<string, unknown>) => (await c.callTool({ name, arguments: args }, undefined, { timeout: 60_000 })).structuredContent as any;

  const reg = await call("register_medicine_strip", { photo_id: await upload("ref"), medication: "Amlodipine", total_cavities: 10, pills_in_strip: 10, rows: 2 });
  assert.equal(reg.ok, true, JSON.stringify(reg));
  assert.equal(reg.data.medication_id, "med_amlo");

  const base = await call("inspect_medicine_strip", { photo_id: await upload("p10") });
  assert.equal(base.data.recognised, true, JSON.stringify(base.data));
  assert.equal(base.data.pills_remaining, 10);
  assert.equal(base.data.verdict, "baseline");

  // One pill gone, nothing recorded: the server asks the person (elicitation); "yes" records the dose.
  const one = await call("inspect_medicine_strip", { photo_id: await upload("p9") });
  assert.equal(one.data.verdict, "unrecorded_dose");
  assert.equal(asked.length, 1);
  assert.match(asked[0], /one more Amlodipine/);
  assert.equal(one.data.recorded?.status, "recorded");

  // Two more gone right after a recorded dose: possible double dose -> urgent alert, no question.
  const two = await call("inspect_medicine_strip", { photo_id: await upload("p7") });
  assert.equal(two.data.pills_remaining, 7);
  assert.equal(two.data.verdict, "possible_double_dose");
  assert.equal(two.data.family_alerted, true);
  assert.equal(asked.length, 1, "no approval question for an emergency");
  const alerts = (await call("list_alerts", {})).data;
  assert.ok(alerts.some((a: any) => a.kind === "strip_double_dose" && a.severity === "urgent"));

  const img = await fetch(`${BASE}${two.data.evidence.annotated_image}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/jpeg");
  await c.close();
});

test("unknown photo is refused, nothing recorded", { skip }, async () => {
  const c = new Client({ name: "plain", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
  const blank = Buffer.from(execFileSync(PY, ["-c", "import cv2,numpy,sys; sys.stdout.buffer.write(cv2.imencode('.jpg', numpy.full((600,800,3),120,numpy.uint8))[1].tobytes())"]));
  const up = await (await fetch(`${BASE}/api/vision/photo`, { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: blank })).json();
  const r = (await c.callTool({ name: "inspect_medicine_strip", arguments: { photo_id: up.photo_id } })).structuredContent as any;
  assert.equal(r.data.recognised, false);
  await c.close();
});
