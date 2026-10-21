import React, { useCallback, useEffect, useRef, useState } from "react";
import { callTool, onTrace, setElicitHandler, trace, type TraceEvent } from "./mcp";

type AnsweredBy = { mode: string; model: string | null; fallback: { from: string; reason: string } | null };
type Turn = { role: "user" | "assistant"; text: string; by?: AnsweredBy };
type ModeInfo = { configured: string; model: string | null; effective: string; credentials: { ok: boolean; error?: string } | null };
type Orb = "idle" | "listening" | "thinking" | "speaking";

// Ordered to follow the demo story: scam call, duplicate dose, refill approval, stroke signs.
const SUGGESTIONS = [
  "A man from the bank is still on the line asking for my OTP",
  "I just took my blood pressure pill",
  "I took my BP pill",
  "I took another one",
  "Am I running low on any medicine?",
  "My face feels strange and my words are coming out wrong",
  "Good morning, what do I need to do today?",
  "When is my next doctor appointment?",
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
  const [mode, setMode] = useState<ModeInfo | null>(null);
  const [tick, setTick] = useState(0);
  const [clock, setClock] = useState<{ now: string; simulated: boolean } | null>(null);
  // A question the MCP server is asking the person on this device (elicitation), relayed by the agent.
  const [deviceAsk, setDeviceAsk] = useState<{ id: string; message: string } | null>(null);
  const deviceAskRef = useRef<{ id: string; message: string } | null>(null);
  const [stripImage, setStripImage] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  deviceAskRef.current = deviceAsk;
  const recRef = useRef<any>(null);
  const orbRef = useRef<Orb>("idle");
  orbRef.current = orb;

  useEffect(() => onTrace((e) => setEvents((xs) => [e, ...xs].slice(0, 200))), []);
  // Re-checked after every reply, so the badge reflects whether Bedrock credentials work right now.
  useEffect(() => { fetch("/api/agent/mode").then((r) => r.json()).then(setMode).catch(() => setMode(null)); }, [tick]);
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

  const send = useCallback(async (text: string, photoId?: string) => {
    text = text.trim();
    if (!text || orb === "thinking") return;
    const history = [...turns, { role: "user" as const, text }];
    setTurns(history);
    setInput("");
    setOrb("thinking");
    trace({ source: "agent", kind: "user", label: `“${text}”` });
    let final = "";
    let by: AnsweredBy | undefined;
    try {
      const res = await fetch("/api/agent/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ history, speaker, elicitation: true, ...(photoId ? { photo_id: photoId } : {}) }) });
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
          else if (e.type === "tool_result") {
            trace({ source: "agent", kind: "tools/call", label: e.name, ok: e.ok, ms: e.ms, detail: e.result });
            if (e.name === "inspect_medicine_strip") setStripImage(e.result?.data?.evidence?.annotated_image ? `${e.result.data.evidence.annotated_image}?t=${Date.now()}` : null);
          }
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
          else if (e.type === "final") {
            final = e.text;
            by = { mode: e.mode, model: e.model ?? null, fallback: e.fallback ?? null };
            trace({ source: "agent", kind: "final", label: `${answeredLabel(by)} · ${e.total_ms} ms`, ok: !e.fallback });
          }
        }
      }
    } catch (e: any) {
      final = `Sorry, something went wrong (${e?.message ?? e}). Nothing new was saved.`;
      trace({ source: "agent", kind: "error", label: final, ok: false });
    }
    setTurns((t) => [...t, { role: "assistant", text: final, by }]);
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
  // "Show a strip": camera photo -> resized in the browser -> uploaded -> sent with the message.
  const showStrip = async (file: File) => {
    try {
      setStripImage(null);
      const blob = await downscale(file, 1600);
      const up = await fetch("/api/vision/photo", { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: blob }).then((r) => r.json());
      if (!up.ok) throw new Error(up.error);
      trace({ source: "dashboard", kind: "photo", label: `Strip photo uploaded (${Math.round(blob.size / 1024)} KB)`, ok: true });
      send("I'm showing you my medicine strip.", up.photo_id);
    } catch (e: any) {
      trace({ source: "dashboard", kind: "photo", label: `Photo upload failed: ${e?.message ?? e}`, ok: false });
    }
  };

  const lastAssistant = last.find((t) => t.role === "assistant");
  const lastUser = last.find((t) => t.role === "user");

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <svg className="logo" viewBox="0 0 40 40" aria-hidden>
            <circle cx="20" cy="20" r="15" fill="none" stroke="currentColor" strokeWidth="5" />
            <circle cx="20" cy="20" r="5.5" fill="currentColor" />
          </svg>
          <div>
            <h1>CareCircle</h1>
            <p className="sub">Ask before you act. A voice companion for Asha, and a window for her family.</p>
          </div>
        </div>
        <div className="top-actions">
          <span className={`pill ${mode?.effective === "bedrock" || mode?.effective === "nebius" ? "pill-good" : mode?.configured !== "rules" ? "pill-warn" : "pill-muted"}`}
            title={mode?.credentials && !mode.credentials.ok ? `Bedrock configured but credentials failed: ${mode.credentials.error}` : mode?.model ?? "Deterministic rule-based planner"}>
            {!mode ? "Agent offline" : mode.effective === "bedrock" ? "Amazon Bedrock, Nova Pro" : mode.effective === "nebius" ? "NVIDIA Nemotron on Nebius" : mode.configured !== "rules" ? "Model unavailable, using rules" : "Rule-based agent"}
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
        <section className={`echo card device ${mobilePane === "echo" ? "" : "hide-mobile"}`} aria-label="Asha's CareCircle device">
          <div className="device-label"><span className="dot" aria-hidden /> Asha's kitchen speaker</div>
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
              : lastAssistant ? <><p className="reply">{lastAssistant.text}</p>{lastAssistant.by && <p className={`answered ${lastAssistant.by.fallback ? "warn-text" : "muted"}`}>{answeredLabel(lastAssistant.by)}</p>}</>
              : <p className="reply muted">Hi Asha. Ask me about your medicines, appointments, or anything that worries you.</p>}
          </div>

          {stripImage && <figure className="strip-result"><img src={stripImage} alt="Strip check: green circles are pills found, red are empty cavities" /><figcaption>OpenCV strip check: green = pill, red = empty</figcaption></figure>}
          <div className="camera-row">
            <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) showStrip(f); e.target.value = ""; }} />
            <button className="ghost" onClick={() => fileRef.current?.click()} disabled={orb === "thinking"}>📷 Show a medicine strip</button>
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

        <section className={`side ${mobilePane === "side" ? "" : "hide-mobile"}`} aria-label="Family app on Ravi's phone">
          <div className="phone">
            <div className="phone-bar" aria-hidden><span className="phone-notch" /></div>
            <div className="phone-screen">
              <div className="tabs desktop-only" role="tablist">
                <button role="tab" aria-selected={tab === "family"} onClick={() => setTab("family")}>Family</button>
                <button role="tab" aria-selected={tab === "trace"} onClick={() => setTab("trace")}>What happened {events.length ? `(${events.length})` : ""}</button>
              </div>
              {tab === "family" ? <Family tick={tick} /> : <Trace events={events} />}
            </div>
          </div>
        </section>
      </main>
      <Features />
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

      <StripCard busyKey={busy} setBusyKey={setBusy} />

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

/** Phone photos are large; shrink before upload (keeps the strip check fast). */
async function downscale(file: File, maxSide: number): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  return await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("encode failed"))), "image/jpeg", 0.88));
}

function StripCard({ busyKey, setBusyKey }: { busyKey: string | null; setBusyKey: (k: string | null) => void }) {
  const [checks, setChecks] = useState<any[]>([]);
  const [meds, setMeds] = useState<any[]>([]);
  const [med, setMed] = useState("");
  const [total, setTotal] = useState(10);
  const [inStrip, setInStrip] = useState(10);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; preview?: string } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const load = useCallback(async () => {
    const [c, m] = await Promise.all([callTool("list_strip_checks", { limit: 4 }, true), callTool("list_medications", {}, true)]);
    if (c.ok) setChecks(c.data as any[]);
    if (m.ok) { setMeds(m.data as any[]); setMed((x) => x || (m.data as any[])[0]?.id || ""); }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, [load]);
  const register = async (f: File) => {
    setBusyKey("register"); setMsg(null);
    try {
      const blob = await downscale(f, 1600);
      const up = await fetch("/api/vision/photo", { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: blob }).then((r) => r.json());
      if (!up.ok) throw new Error(up.error);
      const r = await callTool("register_medicine_strip", { photo_id: up.photo_id, medication: med, total_cavities: total, pills_in_strip: inStrip });
      if (!r.ok) throw new Error(r.error.message);
      const d: any = r.data;
      setMsg({ ok: true, text: `Registered ${d.registered}: ${d.cavities} cavities found.${d.warning ? " " + d.warning : ""}`, preview: `${d.preview}?t=${Date.now()}` });
      load();
    } catch (e: any) { setMsg({ ok: false, text: e?.message ?? String(e) }); }
    setBusyKey(null);
  };
  return (
    <div className="card">
      <h2>Strip checks (camera)</h2>
      {checks.length === 0 ? <p className="muted small">No strip checks yet. Register a strip below, then use "Show a medicine strip" on her device.</p> : (
        <div className="strips">
          {checks.map((c, i) => (
            <figure key={i} className={`strip-thumb v-${c.verdict}`}>
              <img src={c.image} alt={`${c.medication} strip, ${c.remaining} of ${c.total} left`} />
              <figcaption><b>{c.medication}</b> {c.remaining}/{c.total} left · {String(c.verdict).replace(/_/g, " ")} · {c.at.split(" ")[1]}</figcaption>
            </figure>
          ))}
        </div>
      )}
      <details className="register">
        <summary>Register a strip (one reference photo per medicine)</summary>
        <p className="muted small">Lay the strip flat, photograph from straight above in good light, bump side up.</p>
        <div className="reg-row">
          <label>Medicine <select value={med} onChange={(e) => setMed(e.target.value)}>{meds.map((m) => <option key={m.id} value={m.id}>{m.name} {m.dose}</option>)}</select></label>
          <label>Cavities <input type="number" min={1} max={60} value={total} onChange={(e) => setTotal(+e.target.value)} /></label>
          <label>Pills in it now <input type="number" min={0} max={60} value={inStrip} onChange={(e) => setInStrip(+e.target.value)} /></label>
        </div>
        <input ref={file} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) register(f); e.target.value = ""; }} />
        <button disabled={busyKey === "register" || !med} onClick={() => file.current?.click()}>{busyKey === "register" ? "Registering…" : "Take reference photo"}</button>
        {msg && <p className={msg.ok ? "claimed" : "warn-text"}>{msg.text}</p>}
        {msg?.preview && <img className="reg-preview" src={msg.preview} alt="Detected cavities on the reference strip" />}
      </details>
    </div>
  );
}

// ---------------- What CareCircle does (illustrated explainer) ----------------
const FEATURES: { title: string; body: string; example: string; art: React.ReactElement }[] = [
  {
    title: "Scam guard",
    body: "Asha describes a call or message. CareCircle checks it against common scam patterns before she shares anything.",
    example: "\"The bank man wants my OTP\" → \"Hang up now\", and Ravi is alerted.",
    art: (<svg viewBox="0 0 96 72" aria-hidden><rect x="20" y="8" width="34" height="56" rx="7" fill="var(--paper)" stroke="var(--ink)" strokeWidth="2.5" /><rect x="26" y="16" width="22" height="30" rx="3" fill="var(--tint-cream)" /><path d="M58 22c8 0 16 4 16 4v14c0 10-8 16-16 19-8-3-16-9-16-19V26s8-4 16-4z" fill="var(--sindoor-soft)" stroke="var(--sindoor)" strokeWidth="2.5" /><path d="M58 32v10" stroke="var(--sindoor)" strokeWidth="3" strokeLinecap="round" /><circle cx="58" cy="48" r="2" fill="var(--sindoor)" /></svg>),
  },
  {
    title: "Dose check",
    body: "Every \"I took my pill\" is checked against the record. If it looks like a second dose, CareCircle asks before anything else.",
    example: "\"Is that the dose you mean, or did you take another one?\"",
    art: (<svg viewBox="0 0 96 72" aria-hidden><circle cx="36" cy="36" r="22" fill="var(--paper)" stroke="var(--ink)" strokeWidth="2.5" /><path d="M36 22v14l9 6" stroke="var(--ink)" strokeWidth="2.5" strokeLinecap="round" fill="none" /><rect x="56" y="26" width="30" height="14" rx="7" transform="rotate(-30 71 33)" fill="var(--tint-pistachio)" stroke="var(--tulsi)" strokeWidth="2.5" /><path d="M66 38l9-15" stroke="var(--tulsi)" strokeWidth="2" /></svg>),
  },
  {
    title: "Strip check (camera)",
    body: "Show a medicine strip to the camera. OpenCV recognises the medicine and counts what's left, then compares it with the record.",
    example: "One more pill gone than recorded → \"Did you take it? Shall I note it?\"",
    art: (<svg viewBox="0 0 96 72" aria-hidden><rect x="10" y="18" width="62" height="36" rx="6" fill="var(--paper)" stroke="var(--ink)" strokeWidth="2.5" />{[0, 1, 2, 3].map((i) => <circle key={`a${i}`} cx={22 + i * 13} cy="29" r="5" fill={i === 3 ? "var(--paper)" : "var(--tint-mint)"} stroke="var(--tulsi)" strokeWidth="2" />)}{[0, 1, 2, 3].map((i) => <circle key={`b${i}`} cx={22 + i * 13} cy="43" r="5" fill="var(--tint-mint)" stroke="var(--tulsi)" strokeWidth="2" />)}<rect x="62" y="40" width="26" height="20" rx="4" fill="var(--tint-cream)" stroke="var(--ink)" strokeWidth="2.5" /><circle cx="75" cy="50" r="5" fill="none" stroke="var(--ink)" strokeWidth="2.5" /></svg>),
  },
  {
    title: "Family alerts with a deadline",
    body: "Urgent alerts go to Ravi first. If nobody responds in 3 minutes, Neha is told, then Asha hears to call 112.",
    example: "Ravi taps \"I'm calling her now\" and her speaker says so out loud.",
    art: (<svg viewBox="0 0 96 72" aria-hidden><rect x="14" y="10" width="28" height="52" rx="6" fill="var(--paper)" stroke="var(--ink)" strokeWidth="2.5" /><rect x="54" y="10" width="28" height="52" rx="6" fill="var(--paper)" stroke="var(--ink)" strokeWidth="2.5" /><path d="M42 30h12" stroke="var(--haldi)" strokeWidth="3" strokeLinecap="round" strokeDasharray="3 4" /><path d="M28 26c0-4 3-6 0-6s0 2 0 6zM24 32h8" stroke="var(--haldi)" strokeWidth="2.5" strokeLinecap="round" fill="var(--haldi-soft)" /><circle cx="68" cy="30" r="6" fill="var(--leaf-soft)" stroke="var(--leaf)" strokeWidth="2.5" /><path d="M65 30l2 2 4-4" stroke="var(--leaf)" strokeWidth="2" fill="none" strokeLinecap="round" /></svg>),
  },
  {
    title: "Asks before acting",
    body: "Refills and appointment changes only happen after a clear yes, on her speaker or on the family app. The AI cannot approve them by itself.",
    example: "\"Send a refill request for Amlodipine?\" Yes / No",
    art: (<svg viewBox="0 0 96 72" aria-hidden><rect x="14" y="14" width="68" height="44" rx="10" fill="var(--paper)" stroke="var(--ink)" strokeWidth="2.5" /><rect x="22" y="38" width="24" height="12" rx="6" fill="var(--tulsi)" /><rect x="50" y="38" width="24" height="12" rx="6" fill="none" stroke="var(--ink-soft)" strokeWidth="2" /><path d="M24 26h40" stroke="var(--ink)" strokeWidth="2.5" strokeLinecap="round" /></svg>),
  },
  {
    title: "Emergency signs, never missed",
    body: "Stroke signs, chest pain, breathing trouble or a bad fall are recognised by fixed rules on every message, even if the AI is down.",
    example: "\"My face feels droopy\" → \"Please call 112 now\", and family is alerted.",
    art: (<svg viewBox="0 0 96 72" aria-hidden><path d="M48 60S16 42 16 26c0-9 7-15 15-15 7 0 12 4 17 10 5-6 10-10 17-10 8 0 15 6 15 15 0 16-32 34-32 34z" fill="var(--sindoor-soft)" stroke="var(--sindoor)" strokeWidth="2.5" /><path d="M24 34h12l5-9 7 18 5-9h19" stroke="var(--sindoor)" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>),
  },
];

function Features() {
  return (
    <section className="features" aria-labelledby="features-title">
      <h2 id="features-title">What CareCircle does</h2>
      <p className="features-lead">Six things it does for Asha and her family. Safety rules run as fixed code; the AI handles the conversation.</p>
      <div className="feature-grid">
        {FEATURES.map((f) => (
          <article key={f.title} className="feature">
            <div className="feature-art">{f.art}</div>
            <h3>{f.title}</h3>
            <p>{f.body}</p>
            <p className="feature-eg">{f.example}</p>
          </article>
        ))}
      </div>
    </section>
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

function answeredLabel(by: AnsweredBy) {
  if (by.mode === "safety-screen") return "Answered by the deterministic safety screen";
  if (by.mode === "approval") return "Your yes/no was applied directly (no model involved)";
  if (by.mode === "dose-check") return "Handled by the deterministic dose check (no model involved)";
  if (by.mode === "bedrock") return `Answered by Amazon Bedrock (${by.model})`;
  if (by.mode === "bedrock-partial") return `Bedrock failed part-way (${by.fallback?.reason}); no retry, to avoid duplicate actions`;
  if (by.fallback) return `Rule-based fallback: Bedrock unavailable (${by.fallback.reason})`;
  return "Answered by the rule-based planner";
}
