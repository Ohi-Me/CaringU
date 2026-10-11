// Regression tests for the "same reply to every message" bug (2026-10-11):
// root cause was an expired AWS login session -> silent fallback to the rule
// planner, whose catch-all reply was always today's overview.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const procs: ChildProcess[] = [];
async function startServer(port: number, env: Record<string, string>) {
  const p = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    env: { ...process.env, PORT: String(port), DB_PATH: ":memory:", WEB_DIST: "__none__", ...env }, stdio: "ignore",
  });
  procs.push(p);
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) {
        await fetch(`http://127.0.0.1:${port}/api/reset`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ time: "10:00" }) });
        return;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
}
async function chat(port: number, text: string) {
  const r = await fetch(`http://127.0.0.1:${port}/api/agent/chat`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ history: [{ role: "user", text }] }) });
  const raw = await r.text();
  const ev = raw.trim().split("\n").map((l) => JSON.parse(l));
  return { raw, ev, final: ev.find((e) => e.type === "final") };
}

const RULES = 8801, BROKEN_BEDROCK = 8802;
before(async () => {
  // Isolated AWS config: a profile that does not exist, so credential resolution fails
  // locally and deterministically (no network, never touches the developer's real ~/.aws).
  const nowhere = join(tmpdir(), "carecircle-no-aws");
  await Promise.all([
    startServer(RULES, { AGENT_MODE: "rules" }),
    startServer(BROKEN_BEDROCK, { AGENT_MODE: "bedrock", AWS_PROFILE: "carecircle-test-missing-profile",
      AWS_CONFIG_FILE: join(nowhere, "config"), AWS_SHARED_CREDENTIALS_FILE: join(nowhere, "credentials"),
      AWS_ACCESS_KEY_ID: "", AWS_SECRET_ACCESS_KEY: "", AWS_SESSION_TOKEN: "" }),
  ]);
});
after(() => { procs.forEach((p) => p.kill()); });

test("distinct messages get distinct, relevant replies (no repeated catch-all)", async () => {
  const intro = await chat(RULES, "Hello! Please introduce yourself as CareCircle in one sentence.");
  const gibberish = await chat(RULES, "purple elephants dance on tuesday");
  const today = await chat(RULES, "What do I need to do today?");
  assert.match(intro.final.text, /CareCircle/);
  assert.doesNotMatch(gibberish.final.text, /record of Amlodipine/, "unrecognised input must not get the schedule reply");
  assert.match(today.final.text, /Amlodipine/);
  const texts = [intro, gibberish, today].map((r) => r.final.text);
  assert.equal(new Set(texts).size, 3, `replies should differ: ${JSON.stringify(texts)}`);
  for (const r of [intro, gibberish, today]) {
    assert.equal(r.final.mode, "rules");
    assert.equal(r.final.fallback, null);
  }
});

test("Bedrock credential failure: falls back, says so precisely, leaks nothing", async () => {
  const mode = await (await fetch(`http://127.0.0.1:${BROKEN_BEDROCK}/api/agent/mode`)).json();
  assert.equal(mode.configured, "bedrock");
  assert.equal(mode.credentials.ok, false);
  assert.equal(mode.effective, "rules");

  const r = await chat(BROKEN_BEDROCK, "Hello! Please introduce yourself as CareCircle in one sentence.");
  assert.ok(r.ev.some((e) => e.type === "warning" && /Bedrock unavailable/.test(e.message)), "trace must show the fallback");
  assert.equal(r.final.mode, "rules");
  assert.equal(r.final.fallback.from, "bedrock");
  assert.match(r.final.fallback.reason, /Credential|profile|credential/i);
  assert.match(r.final.text, /CareCircle/);
  assert.doesNotMatch(r.raw, /AKIA|ASIA|aws_secret_access_key|SecretAccessKey/i);
});

test("safety screen still answers emergencies when Bedrock is down", async () => {
  const r = await chat(BROKEN_BEDROCK, "My face feels droopy and my words are coming out wrong");
  assert.equal(r.final.mode, "safety-screen");
  assert.match(r.final.text, /112/);
});
