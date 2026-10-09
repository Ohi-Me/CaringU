import { useCallback, useEffect, useRef, useState } from "react";
import { callTool, onTrace, trace, type TraceEvent } from "./mcp";

type Turn = { role: "user" | "assistant"; text: string };
type Orb = "idle" | "listening" | "thinking" | "speaking";

const SUGGESTIONS = [
  "Good morning, what do I need to do today?",
  "Did I take my BP pill?",
  "I just took my blood pressure pill",
  "Am I running low on any medicine?",
  "When is my next doctor appointment?",
  "A man called from the bank asking for my OTP and to install AnyDesk",
  "I feel dizzy and a bit of chest pain",
];

export default function App() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [orb, setOrb] = useState<Orb>("idle");
  const [input, setInput] = useState("");
  const [speaker, setSpeaker] = useState("Asha (voice)");
  const [voiceOn, setVoiceOn] = useState(true);
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [tab, setTab] = useState<"family" | "trace">("family");
  const [mobilePane, setMobilePane] = useState<"echo" | "side">("echo");
  const [mode, setMode] = useState<{ mode: string; model: string | null } | null>(null);
  const [tick, setTick] = useState(0);
  const [clock, setClock] = useState<{ now: string; simulated: boolean } | null>(null);
  const recRef = useRef<any>(null);

  useEffect(() => onTrace((e) => setEvents((xs) => [e, ...xs].slice(0, 200))), []);
  useEffect(() => { fetch("/api/agent/mode").then((r) => r.json()).then(setMode).catch(() => setMode(null)); }, []);
  useEffect(() => {
    const load = () => fetch("/api/clock").then((r) => r.json()).then(setClock).catch(() => {});
    load(); const t = setInterval(load, 30000); return () => clearInterval(t);
  }, [tick]);

  const speak = useCallback((text: string) => {
    if (!voiceOn || !("speechSynthesis" in window)) { setOrb("idle"); return; }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.95;
    u.onend = () => setOrb("idle");
    u.onerror = () => setOrb("idle");
    setOrb("speaking");
    speechSynthesis.speak(u);
  }, [voiceOn]);

  const send = useCallback(async (text: string) => {
    text = text.trim();
    if (!text || orb === "thinking") return;
    const history = [...turns, { role: "user" as const, text }];
    setTurns(history);
    setInput("");
    setOrb("thinking");
    trace({ source: "agent", kind: "user", label: `“${text}”` });
    let final = "";
    try {
      const res = await fetch("/api/agent/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ history, speaker }) });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          const e = JSON.parse(line);
          if (e.type === "mcp") trace({ source: "agent", kind: "mcp", label: e.method === "initialize" ? `initialize → protocol ${e.protocolVersion}` : `tools/list → ${e.count} tools`, ok: true, ms: e.ms });
          else if (e.type === "tool_result") trace({ source: "agent", kind: "tools/call", label: e.name, ok: e.ok, ms: e.ms, detail: e.result });
          else if (e.type === "model") trace({ source: "agent", kind: "model", label: `Bedrock ${e.model} step ${e.step + 1} (${e.stop})`, ok: true, ms: e.ms, detail: e.usage });
          else if (e.type === "warning") trace({ source: "agent", kind: "warning", label: e.message, ok: false });
          else if (e.type === "error") { trace({ source: "agent", kind: "error", label: e.message, ok: false }); final = `Sorry, I couldn't reach CareCircle. ${e.message}`; }
          else if (e.type === "final") { final = e.text; trace({ source: "agent", kind: "final", label: `${e.mode === "bedrock" ? "Bedrock" : "Rule"} agent replied in ${e.total_ms} ms`, ok: true }); }
        }
      }
    } catch (e: any) {
      final = `Sorry, something went wrong (${e?.message ?? e}). Nothing new was saved.`;
      trace({ source: "agent", kind: "error", label: final, ok: false });
    }
    setTurns((t) => [...t, { role: "assistant", text: final }]);
    setTick((x) => x + 1);
    speak(final);
  }, [turns, orb, speaker, speak]);

  const listen = () => {
    const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!SR) { alert("Voice input needs Chrome or Edge. You can type instead."); return; }
    if (orb === "listening") { recRef.current?.stop(); return; }
    speechSynthesis?.cancel();
    const rec = new SR();
    rec.lang = "en-IN"; rec.interimResults = true; rec.maxAlternatives = 1;
    let heard = "";
    rec.onresult = (ev: any) => { heard = Array.from(ev.results).map((r: any) => r[0].transcript).join(" "); setInput(heard); };
    rec.onerror = () => setOrb("idle");
    rec.onend = () => { setOrb("idle"); if (heard.trim()) send(heard); };
    recRef.current = rec;
    setOrb("listening");
    rec.start();
  };

  const reset = async (time?: string) => {
    if (!confirm(time ? `Reset all sample data and start the demo day at ${time}?` : "Reset all sample data using the real current time?")) return;
    speechSynthesis?.cancel();
    await fetch("/api/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(time ? { time } : {}) });
    setTurns([]); setEvents([]); setTick((x) => x + 1);
  };

  const last = [...turns].reverse();
  const lastAssistant = last.find((t) => t.role === "assistant");
  const lastUser = last.find((t) => t.role === "user");

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className="logo" aria-hidden>◎</span>
          <div>
            <h1>CareCircle</h1>
            <p className="sub">Voice-first care companion · independent Alexa+-style simulation · sample data</p>
          </div>
        </div>
        <div className="top-actions">
          <span className={`pill ${mode?.mode === "bedrock" ? "pill-good" : "pill-muted"}`} title={mode?.model ?? "Deterministic rule-based planner"}>
            {mode ? (mode.mode === "bedrock" ? "Amazon Bedrock agent" : "Rule-based agent") : "Agent offline"}
          </span>
          <span className="pill pill-muted">MCP 2025-11-25 · Streamable HTTP</span>
          {clock && <span className={`pill ${clock.simulated ? "pill-warn" : "pill-muted"}`} title={clock.now}>{clock.simulated ? "Demo time " : "Time "}{new Date(clock.now).toTimeString().slice(0, 5)}</span>}
          <button className="ghost" onClick={() => reset("10:00")} title="Reset sample data and start at 10:00">Reset demo (10:00)</button>
          <button className="ghost" onClick={() => reset()} title="Reset sample data using the real time">Reset (now)</button>
        </div>
      </header>

      <nav className="mobile-tabs" role="tablist">
        <button role="tab" aria-selected={mobilePane === "echo"} onClick={() => setMobilePane("echo")}>Talk</button>
        <button role="tab" aria-selected={mobilePane === "side" && tab === "family"} onClick={() => { setMobilePane("side"); setTab("family"); }}>Family</button>
        <button role="tab" aria-selected={mobilePane === "side" && tab === "trace"} onClick={() => { setMobilePane("side"); setTab("trace"); }}>MCP trace</button>
      </nav>

      <main className="grid">
        <section className={`echo card ${mobilePane === "echo" ? "" : "hide-mobile"}`} aria-label="Voice assistant">
          <div className="speaker-row">
            <label>Speaking as{" "}
              <select value={speaker} onChange={(e) => setSpeaker(e.target.value)}>
                <option>Asha (voice)</option><option>Ravi (son)</option><option>Neha (daughter)</option>
              </select>
            </label>
            <label className="toggle"><input type="checkbox" checked={voiceOn} onChange={(e) => { setVoiceOn(e.target.checked); speechSynthesis?.cancel(); }} /> Speak replies</label>
          </div>

          <button className={`orb orb-${orb}`} onClick={listen} aria-label={orb === "listening" ? "Stop listening" : "Tap to speak"}>
            <span className="ring" /><span className="core">{orb === "listening" ? "Listening…" : orb === "thinking" ? "Working…" : orb === "speaking" ? "Speaking" : "Tap to talk"}</span>
          </button>

          <div className="exchange" aria-live="polite">
            {lastUser && <p className="heard">“{lastUser.text}”</p>}
            {orb === "thinking" ? <p className="reply muted">Checking CareCircle…</p>
              : lastAssistant ? <p className="reply">{lastAssistant.text}</p>
              : <p className="reply muted">Hi Asha. Ask me about your medicines, appointments, or anything that worries you.</p>}
          </div>

          <form className="ask" onSubmit={(e) => { e.preventDefault(); send(input); }}>
            <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Or type here…" aria-label="Message" />
            <button type="submit" disabled={!input.trim() || orb === "thinking"}>Send</button>
          </form>

          <div className="chips">
            {SUGGESTIONS.map((s) => <button key={s} className="chip" onClick={() => send(s)} disabled={orb === "thinking"}>{s}</button>)}
          </div>

          {turns.length > 2 && (
            <details className="history">
              <summary>Conversation ({turns.length} turns)</summary>
              {turns.map((t, i) => <p key={i} className={t.role}><b>{t.role === "user" ? "You" : "CareCircle"}:</b> {t.text}</p>)}
            </details>
          )}
        </section>

        <section className={`side ${mobilePane === "side" ? "" : "hide-mobile"}`}>
          <div className="tabs desktop-only" role="tablist">
            <button role="tab" aria-selected={tab === "family"} onClick={() => setTab("family")}>Family dashboard</button>
            <button role="tab" aria-selected={tab === "trace"} onClick={() => setTab("trace")}>MCP trace {events.length ? `(${events.length})` : ""}</button>
          </div>
          {tab === "family" ? <Family tick={tick} /> : <Trace events={events} />}
        </section>
      </main>
      <footer className="foot">
        Not a medical device and not connected to Alexa or any Echo device. Emergency: call 112 (India) / 911 (US).
      </footer>
    </div>
  );
}

// ---------------- Family dashboard (talks MCP directly from the browser) ----------------
function Family({ tick }: { tick: number }) {
  const [d, setD] = useState<any>(null);
  const [ov, setOv] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const me = "Ravi (son)";

  const load = useCallback(async (quiet = true) => {
    const [a, b] = await Promise.all([callTool("get_family_digest", {}, quiet), callTool("get_care_overview", {}, quiet)]);
    if (a.ok && b.ok) { setD(a.data); setOv(b.data); setErr(null); } else setErr(!a.ok ? a.error.message : !b.ok ? b.error.message : null);
  }, []);
  useEffect(() => { load(false); }, [load, tick]);
  useEffect(() => { const t = setInterval(() => load(true), 5000); return () => clearInterval(t); }, [load]);

  const act = async (key: string, name: string, args: Record<string, unknown>) => {
    setBusy(key);
    const r = await callTool(name, args);
    if (!r.ok) alert(r.error.message);
    await load(true);
    setBusy(null);
  };

  if (err) return <div className="card error">Could not load care data: {err}</div>;
  if (!d || !ov) return <div className="card muted">Connecting over MCP…</div>;

  const pct = d.adherence.adherence_so_far_pct;
  return (
    <div className="family">
      <div className="card stats">
        <Stat label="Doses taken today" value={`${d.adherence.taken}/${d.adherence.scheduled_today}`} />
        <Stat label="Missed" value={d.adherence.missed} tone={d.adherence.missed ? "warn" : undefined} />
        <Stat label="Adherence so far" value={pct === null ? "—" : `${pct}%`} tone={pct !== null && pct < 80 ? "warn" : undefined} />
        <Stat label="Open alerts" value={d.open_alerts.length} tone={d.open_alerts.some((a: any) => a.severity === "urgent") ? "urgent" : undefined} />
      </div>

      {ov.pending_confirmations.length > 0 && (
        <div className="card">
          <h2>Waiting for a yes</h2>
          {ov.pending_confirmations.map((p: any) => (
            <div key={p.confirmation_id} className="row">
              <span>{p.summary}</span>
              <span className="btns">
                <button disabled={!!busy} onClick={() => act(p.confirmation_id, "confirm_action", { confirmation_id: p.confirmation_id, approve: true, confirmed_by: me })}>Approve</button>
                <button className="ghost" disabled={!!busy} onClick={() => act(p.confirmation_id, "confirm_action", { confirmation_id: p.confirmation_id, approve: false, confirmed_by: me })}>Decline</button>
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <h2>Alerts</h2>
        {d.open_alerts.length === 0 ? <p className="muted">All clear.</p> : d.open_alerts.map((a: any) => (
          <div key={a.id} className={`alert sev-${a.severity}`}>
            <div><span className="sev">{a.severity}</span> <span className="when">{a.at.split(" ")[1]}</span><p>{a.message}</p></div>
            <button className="ghost" disabled={busy === a.id} onClick={() => act(a.id, "acknowledge_alert", { alert_id: a.id, acknowledged_by: me })}>Handled</button>
          </div>
        ))}
      </div>

      <div className="card">
        <h2>Today's medicines</h2>
        <ol className="timeline">
          {ov.medication_schedule.map((s: any) => (
            <li key={s.medication_id + s.time} className={`st-${s.status}`}>
              <span className="t">{s.time}</span>
              <span className="m">{s.medication} <small>{s.dose}{s.with_food ? " · with food" : ""}</small></span>
              <span className="s">{s.status.replace("_", " ")}{s.taken_at ? ` ${s.taken_at.split(" ")[1]}` : ""}</span>
            </li>
          ))}
        </ol>
      </div>

      <div className="two">
        <div className="card">
          <h2>Appointments</h2>
          {d.upcoming_appointments.length === 0 ? <p className="muted">None this week.</p> : d.upcoming_appointments.map((a: any) => (
            <div key={a.id} className="appt">
              <b>{a.title}</b><span>{a.starts_at} · {a.with_whom}</span>
              <span className={a.transport === "NOT ARRANGED" ? "warn-text" : "muted"}>Ride: {a.transport}</span>
            </div>
          ))}
        </div>
        <div className="card">
          <h2>Refills (7 days)</h2>
          {d.refills_needed.length === 0 ? <p className="muted">Supplies are fine.</p> : d.refills_needed.map((r: any) => (
            <div key={r.medication_id} className="row">
              <span><b>{r.medication}</b> · {r.pills_left} left, runs out {r.runs_out_on}</span>
              <button disabled={!!busy} onClick={() => act(r.medication_id, "request_refill", { medication: r.medication_id })}>Prepare refill</button>
            </div>
          ))}
        </div>
      </div>

      {d.wellbeing.length > 0 && (
        <div className="card">
          <h2>How she's feeling today</h2>
          {d.wellbeing.map((w: any, i: number) => <p key={i} className={w.red_flag ? "urgent-text" : ""}>{w.at.split(" ")[1]} — “{w.symptoms}”{w.mood ? ` (${w.mood})` : ""}</p>)}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: "warn" | "urgent" }) {
  return <div className={`stat ${tone ?? ""}`}><span className="v">{value}</span><span className="l">{label}</span></div>;
}

// ---------------- MCP trace ----------------
function Trace({ events }: { events: TraceEvent[] }) {
  const [audit, setAudit] = useState<any[]>([]);
  useEffect(() => { fetch("/api/activity").then((r) => r.json()).then(setAudit).catch(() => {}); }, [events.length]);
  return (
    <div className="family">
      <div className="card">
        <h2>Live protocol trace</h2>
        <p className="muted small">Every line is a real JSON-RPC message to the CareCircle MCP server over Streamable HTTP, from the agent (server side) or this dashboard (browser).</p>
        {events.length === 0 ? <p className="muted">Say something to see the tool calls.</p> : (
          <ul className="trace">
            {events.map((e, i) => (
              <li key={i} className={`k-${e.kind.replace("/", "-")} ${e.ok === false ? "bad" : ""}`}>
                <details>
                  <summary>
                    <span className="src">{e.source}</span>
                    <span className="kind">{e.kind}</span>
                    <span className="lbl">{e.label}</span>
                    {e.ms !== undefined && <span className="ms">{e.ms} ms</span>}
                    {e.ok !== undefined && <span className={e.ok ? "okb" : "badb"}>{e.ok ? "ok" : "fail"}</span>}
                  </summary>
                  {e.detail !== undefined && <pre>{JSON.stringify(e.detail, null, 2)}</pre>}
                </details>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="card">
        <h2>Server audit log</h2>
        <table className="audit">
          <thead><tr><th>Time</th><th>Tool</th><th>Result</th><th>ms</th></tr></thead>
          <tbody>{audit.map((a, i) => <tr key={i}><td>{a.at.split(" ")[1]}</td><td>{a.tool}</td><td className={a.ok ? "" : "warn-text"}>{a.ok ? "ok" : a.code}</td><td>{a.latency_ms}</td></tr>)}</tbody>
        </table>
      </div>
    </div>
  );
}
