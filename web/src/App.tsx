import { useCallback, useEffect, useRef, useState } from "react";
import { callTool, onTrace, setElicitHandler, trace, type TraceEvent } from "./mcp";

type Turn = { role: "user" | "assistant"; text: string };
type Orb = "idle" | "listening" | "thinking" | "speaking";

const SUGGESTIONS = [
  "Good morning, what do I need to do today?",
  "Did I take my BP pill?",
  "I just took my blood pressure pill",
  "Am I running low on any medicine?",
  "When is my next doctor appointment?",
  "A man from the bank is still on the line asking for my OTP",
  "I feel a bit dizzy today",
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
  // A question the MCP server is asking the person on this device (elicitation), relayed by the agent.
  const [deviceAsk, setDeviceAsk] = useState<{ id: string; message: string } | null>(null);
  const deviceAskRef = useRef<{ id: string; message: string } | null>(null);
  deviceAskRef.current = deviceAsk;
  const recRef = useRef<any>(null);
  const orbRef = useRef<Orb>("idle");
  orbRef.current = orb;

  useEffect(() => onTrace((e) => setEvents((xs) => [e, ...xs].slice(0, 200))), []);
  useEffect(() => { fetch("/api/agent/mode").then((r) => r.json()).then(setMode).catch(() => setMode(null)); }, []);
  useEffect(() => {
    const load = () => fetch("/api/clock").then((r) => r.json()).then(setClock).catch(() => {});
    load(); const t = setInterval(load, 30000); return () => clearInterval(t);
  }, [tick]);

  const speak = useCallback((text: string, keepState = false) => {
    if (!voiceOn || !("speechSynthesis" in window)) { if (!keepState) setOrb("idle"); return; }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.95;
    // Some browsers never fire onend (no voices, background tab); don't let the device get stuck "speaking".
    // keepState: we are mid-request (e.g. waiting for a yes/no), so return to "thinking", not idle.
    const after: Orb = keepState ? "thinking" : "idle";
    const fallback = setTimeout(() => setOrb((o) => (o === "speaking" ? after : o)), 1500 + text.split(/\s+/).length * 450);
    u.onend = () => { clearTimeout(fallback); setOrb(after); };
    u.onerror = () => { clearTimeout(fallback); setOrb(after); };
    setOrb("speaking");
    speechSynthesis.speak(u);
  }, [voiceOn]);
  const speakRef = useRef(speak);
  speakRef.current = speak;

  // Her device: speak caregiver replies and escalation notices as they arrive (via MCP).
  useEffect(() => {
    const t = setInterval(async () => {
      if (orbRef.current !== "idle") return;
      const r = await callTool<any[]>("get_announcements", {}, true);
      if (!r.ok || !r.data.length) return;
      const msgs = r.data;
      setTurns((ts) => [...ts, ...msgs.map((m) => ({ role: "assistant" as const, text: m.text }))]);
      trace({ source: "dashboard", kind: "announce", label: `Spoken on her device: ${msgs.map((m) => m.text).join(" ")}`, ok: true });
      speak(msgs.map((m) => m.text).join(" "));
      await callTool("mark_announcements_heard", { message_ids: msgs.map((m) => m.message_id) }, true);
      setTick((x) => x + 1);
    }, 4000);
    return () => clearInterval(t);
  }, [speak]);

  const advance = async (minutes: number) => {
    const r = await fetch("/api/clock/advance", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ minutes }) }).then((x) => x.json()).catch(() => null);
    if (r?.ok) trace({ source: "dashboard", kind: "clock", label: `Demo clock +${minutes} min${r.escalated?.length ? ` → escalated ${r.escalated.length} alert(s)` : ""}`, ok: true });
    setTick((x) => x + 1);
  };

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
      const res = await fetch("/api/agent/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ history, speaker, elicitation: true }) });
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
          else if (e.type === "safety") trace({ source: "agent", kind: "safety", label: `Safety screen: health ${e.triage}${e.triage_signals.length ? ` (${e.triage_signals.join(", ")})` : ""} · scam ${e.scam}${e.scam_score !== null ? ` (${e.scam_score}/100)` : ""}`, detail: e });
          else if (e.type === "elicit") {
            trace({ source: "agent", kind: "elicitation", label: `Server asks her: ${e.message}` });
            setDeviceAsk({ id: e.id, message: e.message });
            speakRef.current?.(`${e.message.replace(/\?$/, "")}. Shall I go ahead? Say yes or no.`, true);
          }
          else if (e.type === "elicit_answer") { trace({ source: "agent", kind: "elicitation", label: `Answer sent to server: ${e.answer}`, ok: e.answer !== "no answer" }); setDeviceAsk(null); }
          else if (e.type === "guard") trace({ source: "agent", kind: "guard", label: `Blocked ${e.name}: ${e.reason}`, ok: false, detail: e.args });
          else if (e.type === "error") { trace({ source: "agent", kind: "error", label: e.message, ok: false }); final = `Sorry, I couldn't reach CareCircle. ${e.message}`; }
          else if (e.type === "final") { final = e.text; trace({ source: "agent", kind: "final", label: `${e.mode === "bedrock" ? "Bedrock agent" : e.mode === "safety-screen" ? "Safety screen" : "Rule agent"} replied in ${e.total_ms} ms`, ok: true }); }
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

  const answerDevice = async (approve: boolean) => {
    const a = deviceAskRef.current;
    if (!a) return;
    setDeviceAsk(null);
    speechSynthesis?.cancel();
    await fetch(`/api/agent/elicit/${a.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ approve }) }).catch(() => {});
  };

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
    rec.onend = () => {
      // While the server is waiting for a yes/no, the spoken answer goes to it, not into a new request.
      if (deviceAskRef.current) {
        setOrb("thinking");
        if (/\b(yes|yeah|yep|sure|ok(ay)?|go ahead|haan|ha)\b/i.test(heard)) answerDevice(true);
        else if (/\b(no|nope|don'?t|cancel|nahi)\b/i.test(heard)) answerDevice(false);
        return;
      }
      setOrb("idle");
      if (heard.trim()) send(heard);
    };
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
          <button className="ghost" onClick={() => advance(3)} title="Move the demo clock forward 3 minutes (shows escalation)">+3 min</button>
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
            <span className="ring" /><span className="core">{orb === "listening" ? "Listening…" : deviceAsk ? "Say yes or no" : orb === "thinking" ? "Working…" : orb === "speaking" ? "Speaking" : "Tap to talk"}</span>
          </button>

          {deviceAsk && (
            <div className="ask-card" role="alertdialog" aria-label="Approval needed">
              <p className="ask-q">{deviceAsk.message}</p>
              <p className="muted small">CareCircle's server is asking you directly (MCP elicitation). Nothing happens unless you say yes.</p>
              <div className="btns big">
                <button onClick={() => answerDevice(true)}>Yes, go ahead</button>
                <button className="ghost" onClick={() => answerDevice(false)}>No</button>
              </div>
            </div>
          )}
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
            <button role="tab" aria-selected={tab === "family"} onClick={() => setTab("family")}>Family (Ravi / Neha)</button>
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
const QUICK_REPLIES = ["Don't share anything. I'll call you in 2 minutes.", "Stay seated, help is coming.", "Please hang up the phone now."];

function AlertCard({ a, me, busy, act }: { a: any; me: string; busy: boolean; act: (k: string, n: string, args: Record<string, unknown>) => Promise<void> }) {
  const [msg, setMsg] = useState("");
  const respond = (action: string, message?: string) => act(a.id, "respond_to_alert", { alert_id: a.id, responder: me, action, ...(message ? { message } : {}) });
  const live = a.severity === "urgent" && !a.claimed_by;
  return (
    <div className={`alert sev-${a.severity} ${live ? "live" : ""}`}>
      <div className="alert-body">
        <div className="alert-head">
          <span className="sev">{a.severity}</span> <span className="when">{a.at.split(" ")[1]}</span>
          {a.severity === "urgent" && <span className="chain">Notified: {a.notified.join(" → ")}{a.escalates_at && !a.claimed_by ? ` · next: escalates at ${a.escalates_at.split(" ")[1]}` : ""}</span>}
        </div>
        <p>{a.message}</p>
        {a.claimed_by && <p className="claimed">✓ {a.claimed_by}: {String(a.claimed_action).replace(/_/g, " ")}</p>}
        {live && (
          <div className="respond">
            <div className="btns">
              <button disabled={busy} onClick={() => respond("calling_now")}>I'm calling her now</button>
              <button className="ghost" disabled={busy} onClick={() => respond("on_my_way")}>On my way</button>
            </div>
            <div className="quick">
              {QUICK_REPLIES.map((q) => <button key={q} className="chip" disabled={busy} onClick={() => respond("will_call_soon", q)}>{q}</button>)}
            </div>
            <form className="ask" onSubmit={(e) => { e.preventDefault(); if (msg.trim()) { respond("will_call_soon", msg.trim()); setMsg(""); } }}>
              <input value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Message to speak on her device…" aria-label="Message to her" />
              <button type="submit" disabled={busy || !msg.trim()}>Send</button>
            </form>
          </div>
        )}
        {a.timeline?.length > 1 && (
          <details className="timeline-d"><summary>Timeline ({a.timeline.length})</summary>
            {a.timeline.map((e: any, i: number) => <p key={i} className="small"><b>{e.at}</b> {e.event}: {e.detail}</p>)}
          </details>
        )}
      </div>
      {!live && <button className="ghost" disabled={busy} onClick={() => act(a.id, "acknowledge_alert", { alert_id: a.id, acknowledged_by: me })}>Handled</button>}
    </div>
  );
}

function Family({ tick }: { tick: number }) {
  const [d, setD] = useState<any>(null);
  const [ov, setOv] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [me, setMe] = useState("Ravi (son)");
  // Questions the MCP server sends to this dashboard (elicitation), e.g. "Send a refill request…?"
  const [ask, setAsk] = useState<{ message: string; resolve: (a: { approve: boolean; by: string } | null) => void } | null>(null);
  useEffect(() => {
    setElicitHandler((message) => new Promise((resolve) => setAsk({ message, resolve })));
    return () => setElicitHandler(null);
  }, []);
  const answer = (approve: boolean | null) => {
    if (!ask) return;
    ask.resolve(approve === null ? null : { approve, by: me });
    setAsk(null);
  };

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
      <div className="viewer">
        <label>Family view as{" "}
          <select value={me} onChange={(e) => setMe(e.target.value)}><option>Ravi (son)</option><option>Neha (daughter)</option></select>
        </label>
        <span className="muted small">Urgent alerts go to Ravi first, then Neha if nobody responds.</span>
      </div>
      {ask && (
        <div className="ask-card" role="alertdialog" aria-label="Approval needed">
          <p className="ask-q">{ask.message}</p>
          <p className="muted small">Asked by the CareCircle server over MCP (elicitation). It runs only if you approve.</p>
          <div className="btns big">
            <button onClick={() => answer(true)}>Approve as {me.split(" ")[0]}</button>
            <button className="ghost" onClick={() => answer(false)}>Decline</button>
          </div>
        </div>
      )}
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
          <AlertCard key={a.id} a={a} me={me} busy={busy === a.id} act={act} />
        ))}
      </div>

      {d.messages_to_her?.length > 0 && (
        <div className="card">
          <h2>Said to her device</h2>
          {d.messages_to_her.map((m: any, i: number) => <p key={i} className="small"><b>{m.at}</b> {m.text} <span className="muted">{m.heard ? "· spoken" : "· waiting"}</span></p>)}
        </div>
      )}

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
              {r.refill_requested_at ? <span className="claimed">✓ Requested {r.refill_requested_at.split(" ")[1]}</span> : <button disabled={!!busy} onClick={() => act(r.medication_id, "request_refill", { medication: r.medication_id })}>Prepare refill</button>}
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
