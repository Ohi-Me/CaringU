import React, { useCallback, useEffect, useRef, useState } from "react";
import { callTool, onTrace, setElicitHandler, trace, type TraceEvent } from "./mcp";

type AnsweredBy = { mode: string; model: string | null; fallback: { from: string; reason: string } | null };
type Turn = { role: "user" | "assistant"; text: string; by?: AnsweredBy };
type ModeInfo = { configured: string; model: string | null; effective: string; credentials: { ok: boolean; error?: string } | null };
type Orb = "idle" | "listening" | "thinking" | "speaking";
type Route = "home" | "try" | "about";
type Theme = "auto" | "light" | "dark";

// Ordered to follow the demo story: scam call, duplicate dose, refill approval, stroke signs.
const SUGGESTIONS = [
  "A man from the bank is still on the line asking for my OTP",
  "I just took my blood pressure pill",
  "I took my BP pill",
  "I took another one",
  "Am I running low on any medicine?",
  "Pay the pharmacy 12.50 dollars for my Amlodipine refill",
  "My face feels strange and my words are coming out wrong",
  "Good morning, what do I need to do today?",
  "When is my next doctor appointment?",
];

// Generated sample photos (vision/scripts/make_lens_samples.py) so Scam Lens can be tried without a code to hand.
const LENS_SAMPLES = [
  { file: "prize-flyer.jpg", label: "\"You won ₹5,000\" flyer", say: "This flyer says I won cashback. Should I scan it?" },
  { file: "kyc-message.jpg", label: "Bank KYC message", say: "I got this message that my bank account is blocked." },
  { file: "pharmacy-bill.jpg", label: "Pharmacy bill", say: "This is my pharmacy bill. Is the code okay?" },
];

const PAGES: { id: Route; href: string; label: string }[] = [
  { id: "home", href: "#/", label: "Home" },
  { id: "try", href: "#/try", label: "Try it" },
  { id: "about", href: "#/about", label: "How it's built" },
];
const TITLES: Record<Route, string> = { home: "CaringU", try: "Try CaringU", about: "How CaringU is built" };
const readRoute = (): Route => (location.hash.startsWith("#/try") ? "try" : location.hash.startsWith("#/about") ? "about" : "home");

// Three pages: Home (what it is, with a short animated example), Try it (the live demo),
// How it's built (architecture, tests, the live protocol trace, who built it).
export default function App() {
  const [route, setRoute] = useState<Route>(readRoute);
  // The demo stays mounted after the first visit, so a conversation survives a look at "How it's built".
  const [tried, setTried] = useState(route === "try");
  const [events, setEvents] = useState<TraceEvent[]>([]);
  // Theme: auto follows the device; light/dark are remembered on this device (storage may be unavailable).
  const [theme, setTheme] = useState<Theme>(() => {
    try { const t = localStorage.getItem("cc-theme"); return t === "light" || t === "dark" ? t : "auto"; } catch { return "auto"; }
  });
  useEffect(() => {
    if (theme === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("cc-theme", theme); } catch { /* private mode: keep it for this visit only */ }
  }, [theme]);
  useEffect(() => onTrace((e) => setEvents((xs) => [e, ...xs].slice(0, 200))), []);
  useEffect(() => {
    const on = () => { const r = readRoute(); setRoute(r); if (r === "try") setTried(true); window.scrollTo(0, 0); };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  useEffect(() => { document.title = TITLES[route]; }, [route]);

  return (
    <div className="app">
      <header className="top">
        <a className="brand" href="#/" aria-label="CaringU home">
          <svg className="logo" viewBox="0 0 40 40" aria-hidden>
            <circle cx="20" cy="20" r="15" fill="none" stroke="currentColor" strokeWidth="5" />
            <circle cx="20" cy="20" r="5.5" fill="currentColor" />
          </svg>
          <span>CaringU</span>
        </a>
        <nav className="nav" aria-label="Pages">
          {PAGES.map((p) => <a key={p.id} href={p.href} aria-current={route === p.id ? "page" : undefined}>{p.label}</a>)}
        </nav>
        <Corner theme={theme} setTheme={setTheme} />
      </header>

      {route === "home" && <Home />}
      {tried && <div hidden={route !== "try"}><TryIt active={route === "try"} clearEvents={() => setEvents([])} /></div>}
      {route === "about" && <About events={events} />}

      <footer className="foot">
        Not a medical device and not connected to Alexa or any Echo device. Emergency: call 112 (India) / 911 (US).
      </footer>
    </div>
  );
}

// ---------------- corner: current time and theme ----------------
const THEMES: { id: Theme; label: string; icon: React.ReactElement }[] = [
  { id: "auto", label: "Match this device", icon: <svg viewBox="0 0 20 20" aria-hidden><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M10 3a7 7 0 0 1 0 14z" fill="currentColor" /></svg> },
  { id: "light", label: "Light", icon: <svg viewBox="0 0 20 20" aria-hidden><circle cx="10" cy="10" r="3.5" fill="currentColor" /><path d="M10 1.5v2.5M10 16v2.5M1.5 10H4M16 10h2.5M4 4l1.8 1.8M14.2 14.2 16 16M4 16l1.8-1.8M14.2 5.8 16 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg> },
  { id: "dark", label: "Dark", icon: <svg viewBox="0 0 20 20" aria-hidden><path d="M15.5 12.5A6.5 6.5 0 0 1 7.5 4.5a6.5 6.5 0 1 0 8 8z" fill="currentColor" /></svg> },
];

function Corner({ theme, setTheme }: { theme: Theme; setTheme: (t: Theme) => void }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 10_000); return () => clearInterval(t); }, []);
  return (
    <div className="corner">
      <time className="now" dateTime={now.toISOString()}>
        {now.toLocaleDateString(undefined, { weekday: "short" })} {now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
      </time>
      <div className="theme-switch" role="group" aria-label="Colour theme">
        {THEMES.map((t) => <button key={t.id} aria-pressed={theme === t.id} aria-label={t.label} title={t.label} onClick={() => setTheme(t.id)}>{t.icon}</button>)}
      </div>
    </div>
  );
}

// ---------------- Home ----------------
// The example is the real flow, with the safety screen's reply shortened (the app also lists the warning signs).
const STORY = [
  { label: "Asha asks", text: "A man from the bank is on the line. He wants my OTP." },
  { label: "It warns her", text: "Hang up now. This looks like a scam. Don't share any code or PIN. I've alerted Ravi." },
  { label: "Ravi is alerted", text: "Possible scam call. Asha was told to hang up." },
  { label: "Ravi answers", text: "Ravi is calling you right now. Please pick up." },
];

function Story() {
  const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  // step 0 is the empty kitchen; 1-4 add one beat each. Reduced motion starts on the finished scene.
  const [step, setStep] = useState(reduce ? 4 : 0);
  const [playing, setPlaying] = useState(!reduce);
  useEffect(() => {
    if (!playing) return;
    const t = setTimeout(() => setStep((s) => (s + 1) % 5), step === 0 ? 900 : step === 4 ? 4500 : 2600);
    return () => clearTimeout(t);
  }, [playing, step]);
  const show = (i: number) => (step >= i ? "on" : "");
  return (
    <figure className="story" aria-label="Example: Asha gets a scam call">
      <div className="scene">
        <div className="mini-speaker">
          <div className="mini-top"><span className={`mini-ring ${step === 2 || step === 4 ? "lit" : ""}`} aria-hidden /> Asha's kitchen speaker</div>
          <p className={`bubble b-her ${show(1)}`}><b>Asha</b>“{STORY[0].text}”</p>
          <p className={`bubble b-cc ${show(2)}`}><b>CaringU</b>{STORY[1].text}</p>
          <p className={`bubble b-cc ${show(4)}`}><b>CaringU</b>{STORY[3].text}</p>
        </div>
        <div className="mini-phone">
          <div className="mini-top">Ravi's phone</div>
          <div className={`notif ${show(3)}`}>
            <b className="urgent-text">Urgent</b>
            <span>{STORY[2].text}</span>
            <span className={`notif-btn ${step >= 4 ? "pressed" : ""}`}>{step >= 4 ? "Calling Asha…" : "I'm calling her now"}</span>
          </div>
        </div>
      </div>
      <figcaption className="story-bar">
        <ol className="story-steps">
          {STORY.map((s, i) => (
            <li key={s.label}><button aria-current={step === i + 1 ? "step" : undefined} onClick={() => { setPlaying(false); setStep(i + 1); }}>{s.label}</button></li>
          ))}
        </ol>
        <button className="ghost" onClick={() => { if (playing) setPlaying(false); else { setStep(0); setPlaying(true); } }}>{playing ? "Pause" : "Play again"}</button>
      </figcaption>
    </figure>
  );
}

const POINTS: { title: string; body: string; art: React.ReactElement }[] = [
  {
    title: "Stops scams before she shares anything",
    body: "She describes a call, or shows the camera a QR code or payment request. CaringU checks it for scam signs, tells her what to do, and alerts the family.",
    art: (<svg viewBox="0 0 96 72" aria-hidden><rect x="20" y="8" width="34" height="56" rx="7" fill="var(--paper)" stroke="var(--ink)" strokeWidth="2.5" /><rect x="26" y="16" width="22" height="30" rx="3" fill="var(--wash)" /><path d="M58 22c8 0 16 4 16 4v14c0 10-8 16-16 19-8-3-16-9-16-19V26s8-4 16-4z" fill="var(--sindoor-soft)" stroke="var(--sindoor)" strokeWidth="2.5" /><path d="M58 32v10" stroke="var(--sindoor)" strokeWidth="3" strokeLinecap="round" /><circle cx="58" cy="48" r="2" fill="var(--sindoor)" /></svg>),
  },
  {
    title: "Prevents a double dose",
    body: "Every \"I took my pill\" is checked against the record first. If it looks like a second dose, it asks before anything else.",
    art: (<svg viewBox="0 0 96 72" aria-hidden><circle cx="36" cy="36" r="22" fill="var(--paper)" stroke="var(--ink)" strokeWidth="2.5" /><path d="M36 22v14l9 6" stroke="var(--ink)" strokeWidth="2.5" strokeLinecap="round" fill="none" /><rect x="56" y="26" width="30" height="14" rx="7" transform="rotate(-30 71 33)" fill="var(--haldi-soft)" stroke="var(--haldi)" strokeWidth="2.5" /><path d="M66 38l9-15" stroke="var(--haldi)" strokeWidth="2" /></svg>),
  },
  {
    title: "Keeps the family close",
    body: "Photos and notes from the family are shown and read aloud on her speaker. If she hasn't spoken by 11:00, they get one gentle nudge.",
    art: (<svg viewBox="0 0 96 72" aria-hidden><rect x="14" y="12" width="52" height="44" rx="6" fill="var(--paper)" stroke="var(--ink)" strokeWidth="2.5" /><path d="M20 50l13-14 9 9 7-6 11 11z" fill="var(--wash)" stroke="var(--ink)" strokeWidth="2" strokeLinejoin="round" /><circle cx="50" cy="24" r="4" fill="var(--haldi)" /><path d="M76 58s-12-7-12-14a6 6 0 0 1 12-2 6 6 0 0 1 12 2c0 7-12 14-12 14z" fill="var(--sindoor-soft)" stroke="var(--sindoor)" strokeWidth="2.5" /></svg>),
  },
];

function Home() {
  return (
    <main className="home">
      <section className="hero">
        <div className="hero-text">
          <h1>Ask before you act.</h1>
          <p className="lead">CaringU is a voice companion for a parent who lives alone, and a window for their family. It catches scams and double doses, and it never changes anything without a clear yes.</p>
          <div className="btns">
            <a className="button" href="#/try">Try it yourself</a>
            <a className="button ghost" href="#/about">How it's built</a>
          </div>
        </div>
        <Story />
      </section>

      <section className="points" aria-labelledby="points-title">
        <h2 id="points-title">What it does for Asha and her family</h2>
        <ul>
          {POINTS.map((p) => (
            <li key={p.title}>
              <div className="point-art">{p.art}</div>
              <h3>{p.title}</h3>
              <p>{p.body}</p>
            </li>
          ))}
        </ul>
        <p className="muted">It also recognises emergency signs like a drooping face or chest pain, checks a medicine strip with the camera, pays approved bills through PayPal only within the limits the family set, and alerts Ravi first, then Neha if nobody answers in 3 minutes.</p>
      </section>

      <section className="closing">
        <h2>See it work</h2>
        <p className="muted">The demo shows Asha's speaker and Ravi's phone side by side, with sample data. Voice works in Chrome or Edge; you can also type.</p>
        <a className="button" href="#/try">Try it yourself</a>
      </section>
    </main>
  );
}

// ---------------- Voice ----------------
// Amazon Polly on the server when available (natural voices); otherwise the browser's best voice.
// CaringU speaks in one warm female voice; a family member's own words ("Message from Ravi: …")
// are read in a voice that matches them.
type VoiceKind = "female" | "male";
const GENDER: Record<string, VoiceKind> = {};
let pollyOn: boolean | null = null;
let playing: HTMLAudioElement | null = null;
let voiceToken = 0;
function stopVoice() {
  voiceToken++;
  playing?.pause(); playing = null;
  try { speechSynthesis.cancel(); } catch { /* no speech support */ }
}
function browserVoice(kind: VoiceKind) {
  if (!("speechSynthesis" in window)) return null;
  const female = /female|neerja|swara|heera|kajal|aditi|zira|aria|jenny|samantha|sonia|libby|natasha/i;
  const male = /\bmale|prabhat|madhur|ravi|hemant|guy|david|mark|ryan|thomas|william|daniel/i;
  const score = (v: SpeechSynthesisVoice) => (/natural|neural|online/i.test(v.name) ? 4 : 0) + (/en-IN/i.test(v.lang) ? 2 : /^en/i.test(v.lang) ? 1 : -9)
    + ((kind === "female" ? female : male).test(v.name) ? 3 : (kind === "female" ? male : female).test(v.name) ? -3 : 0);
  return speechSynthesis.getVoices().slice().sort((a, b) => score(b) - score(a))[0] ?? null;
}
function voiceParts(text: string): { text: string; kind: VoiceKind }[] {
  const parts: { text: string; kind: VoiceKind }[] = [];
  const re = /(Message from (\w+): |(\w+) shared a photo: )/g;
  let at = 0, who: string | null = null, m: RegExpExecArray | null;
  const push = (t: string, k: VoiceKind) => { if (t.trim()) parts.push({ text: t.trim(), kind: k }); };
  while ((m = re.exec(text))) {
    push(text.slice(at, m.index), who ? GENDER[who] ?? "female" : "female");
    push(m[1], "female");
    who = m[2] ?? m[3]; at = m.index + m[1].length;
  }
  push(text.slice(at), who ? GENDER[who] ?? "female" : "female");
  return parts;
}
async function sayPart(text: string, kind: VoiceKind, token: number) {
  if (pollyOn !== false) {
    try {
      const r = await fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, voice: kind }) });
      if (r.status === 200) {
        const url = URL.createObjectURL(await r.blob());
        pollyOn = true;
        if (token !== voiceToken) return;
        const a = new Audio(url);
        playing = a;
        await new Promise<void>((done) => { a.onended = () => done(); a.onerror = () => done(); a.play().catch(() => done()); });
        URL.revokeObjectURL(url);
        return;
      }
      pollyOn = false;
    } catch { pollyOn = false; }
  }
  if (!("speechSynthesis" in window) || token !== voiceToken) return;
  await new Promise<void>((done) => {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.95;
    const v = browserVoice(kind); if (v) u.voice = v;
    // Some browsers never fire onend (no voices, background tab); don't wait forever.
    const t = setTimeout(done, 2000 + text.split(/\s+/).length * 450);
    u.onend = () => { clearTimeout(t); done(); };
    u.onerror = () => { clearTimeout(t); done(); };
    speechSynthesis.speak(u);
  });
}

// ---------------- Try it (the live demo) ----------------
function TryIt({ active, clearEvents }: { active: boolean; clearEvents: () => void }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [orb, setOrb] = useState<Orb>("idle");
  const [input, setInput] = useState("");
  const [speaker, setSpeaker] = useState("Asha (voice)");
  const [voiceOn, setVoiceOn] = useState(true);
  const [mobilePane, setMobilePane] = useState<"echo" | "side">("echo");
  const [mode, setMode] = useState<ModeInfo | null>(null);
  const [tick, setTick] = useState(0);
  const [clock, setClock] = useState<{ now: string; simulated: boolean } | null>(null);
  // A question the MCP server is asking the person on this device (elicitation), relayed by the agent.
  const [deviceAsk, setDeviceAsk] = useState<{ id: string; message: string } | null>(null);
  const deviceAskRef = useRef<{ id: string; message: string } | null>(null);
  const [stripImage, setStripImage] = useState<string | null>(null);
  // Which camera check the next photo is for: a medicine strip, or Scam Lens (a QR code or payment request).
  const [cameraKind, setCameraKind] = useState<"strip" | "lens">("strip");
  const [moment, setMoment] = useState<{ from: string; text: string; photo: string; at: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  deviceAskRef.current = deviceAsk;
  const recRef = useRef<any>(null);
  const orbRef = useRef<Orb>("idle");
  orbRef.current = orb;
  const activeRef = useRef(active);
  activeRef.current = active;

  // Leaving the page silences her device.
  useEffect(() => { if (!active) { stopVoice(); recRef.current?.stop(); } }, [active]);
  // Re-checked after every reply, so the status reflects whether the model's credentials work right now.
  useEffect(() => { fetch("/api/agent/mode").then((r) => r.json()).then(setMode).catch(() => setMode(null)); }, [tick]);
  useEffect(() => {
    const load = () => fetch("/api/clock").then((r) => r.json()).then(setClock).catch(() => {});
    load(); const t = setInterval(load, 30000); return () => clearInterval(t);
  }, [tick]);

  // keepState: we are mid-request (e.g. waiting for a yes/no), so return to "thinking", not idle.
  const speak = useCallback((text: string, keepState = false) => {
    const after: Orb = keepState ? "thinking" : "idle";
    if (!voiceOn) { if (!keepState) setOrb("idle"); return; }
    stopVoice();
    const token = voiceToken;
    setOrb("speaking");
    (async () => {
      for (const p of voiceParts(text)) { if (token !== voiceToken) return; await sayPart(p.text, p.kind, token); }
      if (token === voiceToken) setOrb((o) => (o === "speaking" ? after : o));
    })();
  }, [voiceOn]);
  const hush = () => { stopVoice(); setOrb((o) => (o === "speaking" ? "idle" : o)); };
  // Who is male or female in her care circle, so their own words get a matching voice.
  useEffect(() => {
    callTool<any>("get_family_digest", {}, true).then((r) => {
      if (r.ok) for (const p of r.data.people ?? []) GENDER[String(p.name).split(" ")[0]] = /\b(son|husband|brother|father|grandson|nephew)\b/i.test(p.relation ?? "") ? "male" : "female";
    });
  }, []);
  const speakRef = useRef(speak);
  speakRef.current = speak;

  // Her device: speak caregiver replies and escalation notices as they arrive (via MCP), only while this page is open.
  useEffect(() => {
    const t = setInterval(async () => {
      if (!activeRef.current || orbRef.current !== "idle") return;
      const r = await callTool<any[]>("get_announcements", {}, true);
      if (!r.ok || !r.data.length) return;
      const msgs = r.data;
      const withPhoto = msgs.filter((m) => m.photo);
      if (withPhoto.length) setMoment(withPhoto[withPhoto.length - 1]);
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

  const send = useCallback(async (text: string, photoId?: string, photoKind?: "strip" | "lens") => {
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
      const res = await fetch("/api/agent/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ history, speaker, elicitation: true, ...(photoId ? { photo_id: photoId, photo_kind: photoKind ?? "strip" } : {}) }) });
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
            if (e.name === "inspect_medicine_strip" || e.name === "check_code_with_camera") setStripImage(e.result?.data?.evidence?.annotated_image ? `${e.result.data.evidence.annotated_image}?t=${Date.now()}` : null);
          }
          else if (e.type === "model") trace({ source: "agent", kind: "model", label: `${e.model} step ${e.step + 1} (${e.stop})`, ok: true, ms: e.ms, detail: e.usage });
          else if (e.type === "warning") trace({ source: "agent", kind: "warning", label: e.message, ok: false });
          else if (e.type === "safety") trace({ source: "agent", kind: "safety", label: `Safety screen: health ${e.triage}${e.triage_signals.length ? ` (${e.triage_signals.join(", ")})` : ""} · scam ${e.scam}${e.scam_score !== null ? ` (${e.scam_score}/100)` : ""}`, detail: e });
          else if (e.type === "elicit") {
            trace({ source: "agent", kind: "elicitation", label: `Server asks her: ${e.message}` });
            setDeviceAsk({ id: e.id, message: e.message });
            speakRef.current?.(`${e.message.replace(/\?$/, "")}. Shall I go ahead? Say yes or no.`, true);
          }
          else if (e.type === "elicit_answer") { trace({ source: "agent", kind: "elicitation", label: `Answer sent to server: ${e.answer}`, ok: e.answer !== "no answer" }); setDeviceAsk(null); }
          else if (e.type === "guard") trace({ source: "agent", kind: "guard", label: `Blocked ${e.name}: ${e.reason}`, ok: false, detail: e.args });
          else if (e.type === "error") { trace({ source: "agent", kind: "error", label: e.message, ok: false }); final = `Sorry, I couldn't reach CaringU. ${e.message}`; }
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
    stopVoice(); setOrb("thinking");
    await fetch(`/api/agent/elicit/${a.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ approve }) }).catch(() => {});
  };

  const listen = () => {
    const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!SR) { alert("Voice input needs Chrome or Edge. You can type instead."); return; }
    if (orb === "listening") { recRef.current?.stop(); return; }
    stopVoice();
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
    hush();
    await fetch("/api/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(time ? { time } : {}) });
    setTurns([]); clearEvents(); setTick((x) => x + 1);
  };

  const last = [...turns].reverse();
  // Camera: photo -> resized in the browser -> uploaded -> sent with the message (strip check or Scam Lens).
  const showPhoto = async (file: File, kind: "strip" | "lens", say?: string) => {
    try {
      setStripImage(null);
      setCameraKind(kind);
      const blob = await downscale(file, 1600);
      const up = await fetch("/api/vision/photo", { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: blob }).then((r) => r.json());
      if (!up.ok) throw new Error(up.error);
      trace({ source: "dashboard", kind: "photo", label: `${kind === "lens" ? "Scam Lens" : "Strip"} photo uploaded (${Math.round(blob.size / 1024)} KB)`, ok: true });
      // For Scam Lens, anything she typed first is what she was told about the code ("he said I'd get a refund").
      if (kind === "lens") send(say ?? (input.trim() || "Someone sent me this code. Is it safe?"), up.photo_id, "lens");
      else send("I'm showing you my medicine strip.", up.photo_id, "strip");
    } catch (e: any) {
      trace({ source: "dashboard", kind: "photo", label: `Photo upload failed: ${e?.message ?? e}`, ok: false });
    }
  };

  const lastAssistant = last.find((t) => t.role === "assistant");
  const lastUser = last.find((t) => t.role === "user");

  const modeText = !mode ? "The agent is offline."
    : mode.effective === "bedrock" ? `Replies come from Amazon Bedrock (${mode.model}).`
    : mode.effective === "nebius" ? `Replies come from NVIDIA Nemotron on Nebius (${mode.model}).`
    : mode.configured !== "rules" ? `The model is unavailable${mode.credentials?.error ? ` (${mode.credentials.error})` : ""}, so the rule-based planner is answering.`
    : "Replies come from the rule-based planner (no model).";

  return (
    <main className="try">
      <div className="try-head">
        <div>
          <h1>Try it yourself</h1>
          <p className="muted">On the left is Asha's kitchen speaker; on the right, the family app on Ravi's phone. Tap a suggestion, type, or tap the circle and speak. Everything uses sample data.</p>
        </div>
        <details className="demo-controls">
          <summary>Demo controls{clock?.simulated ? `, demo time ${new Date(clock.now).toTimeString().slice(0, 5)}` : ""}</summary>
          <div className="demo-panel">
            <p className="small">{modeText}</p>
            <p className="small muted">Move time forward: 3 minutes passes an alert from Ravi to Neha, 1 hour passes the 11:00 check-in.</p>
            <div className="btns">
              <button className="ghost" onClick={() => advance(3)}>+3 minutes</button>
              <button className="ghost" onClick={() => advance(60)}>+1 hour</button>
            </div>
            <div className="btns">
              <button className="ghost" onClick={() => reset("10:00")}>Restart the day at 10:00</button>
              <button className="ghost" onClick={() => reset()}>Restart at the real time</button>
            </div>
          </div>
        </details>
      </div>

      <nav className="mobile-tabs" role="tablist">
        <button role="tab" aria-selected={mobilePane === "echo"} onClick={() => setMobilePane("echo")}>Asha's speaker</button>
        <button role="tab" aria-selected={mobilePane === "side"} onClick={() => setMobilePane("side")}>Ravi's phone</button>
      </nav>

      <div className="grid">
        <section className={`echo card device ${mobilePane === "echo" ? "" : "hide-mobile"}`} aria-label="Asha's CaringU device">
          <div className="device-label"><span className="dot" aria-hidden /> Asha's kitchen speaker</div>
          <div className="speaker-row">
            <label>Speaking as{" "}
              <select value={speaker} onChange={(e) => setSpeaker(e.target.value)}>
                <option>Asha (voice)</option><option>Ravi (son)</option><option>Neha (daughter)</option>
              </select>
            </label>
            <label className="toggle"><input type="checkbox" checked={voiceOn} onChange={(e) => { setVoiceOn(e.target.checked); hush(); }} /> Speak replies</label>
          </div>

          <button className={`orb orb-${orb}`} onClick={listen} aria-label={orb === "listening" ? "Stop listening" : "Tap to speak"}>
            <span className="ring" /><span className="core">{orb === "listening" ? "Listening…" : deviceAsk ? "Say yes or no" : orb === "thinking" ? "Working…" : orb === "speaking" ? "Speaking" : "Tap to talk"}</span>
          </button>

          {deviceAsk && (
            <div className="ask-card" role="alertdialog" aria-label="Approval needed">
              <p className="ask-q">{deviceAsk.message}</p>
              <p className="muted small">Nothing happens unless you say yes.</p>
              <div className="btns big">
                <button onClick={() => answerDevice(true)}>Yes, go ahead</button>
                <button className="ghost" onClick={() => answerDevice(false)}>No</button>
              </div>
            </div>
          )}
          <div className="exchange" aria-live="polite">
            {lastUser && <p className="heard">“{lastUser.text}”</p>}
            {orb === "thinking" ? <p className="reply muted">Checking CaringU…</p>
              : lastAssistant ? <><p className="reply">{lastAssistant.text}</p>{lastAssistant.by && <p className={`answered ${lastAssistant.by.fallback ? "warn-text" : "muted"}`}>{answeredLabel(lastAssistant.by)}</p>}</>
              : <p className="reply muted">Hi Asha. Ask me about your medicines, appointments, or anything that worries you.</p>}
          </div>

          {moment && (
            <figure className="moment">
              <img src={moment.photo} alt={`Photo shared by ${moment.from}`} />
              <figcaption><b>From {moment.from}</b> {moment.text.replace(/^.*?shared a photo:\s*/, "")}</figcaption>
            </figure>
          )}
          {stripImage && (cameraKind === "lens"
            ? <figure className="strip-result"><img src={stripImage} alt="Scam Lens: the code CaringU read is outlined" /><figcaption>Scam Lens: the code it read is outlined</figcaption></figure>
            : <figure className="strip-result"><img src={stripImage} alt="Strip check: green circles are pills found, red are empty cavities" /><figcaption>Strip check: green = pill, red = empty</figcaption></figure>)}
          <div className="camera-row">
            <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) showPhoto(f, cameraKind); e.target.value = ""; }} />
            <button className="ghost" onClick={() => { setCameraKind("lens"); fileRef.current?.click(); }} disabled={orb === "thinking"}>Check a QR code or payment request</button>
            <button className="ghost" onClick={() => { setCameraKind("strip"); fileRef.current?.click(); }} disabled={orb === "thinking"}>Show a medicine strip</button>
          </div>
          <div className="chips samples">
            <span className="small">No code to hand? Try a sample:</span>
            {LENS_SAMPLES.map((x) => (
              <button key={x.file} className="chip" disabled={orb === "thinking"} onClick={async () => {
                const blob = await fetch(`/samples/${x.file}`).then((r) => r.blob());
                showPhoto(new File([blob], x.file, { type: "image/jpeg" }), "lens", x.say);
              }}>{x.label}</button>
            ))}
          </div>
          <form className="ask" onSubmit={(e) => { e.preventDefault(); send(input); }}>
            <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Or type here…" aria-label="Message" />
            <button type="submit" disabled={!input.trim() || orb === "thinking"}>Send</button>
          </form>

          <div className="chips" aria-label="Things to try">
            {SUGGESTIONS.map((s) => <button key={s} className="chip" onClick={() => send(s)} disabled={orb === "thinking"}>{s}</button>)}
          </div>

          {turns.length > 2 && (
            <details className="history">
              <summary>Conversation ({turns.length} turns)</summary>
              {turns.map((t, i) => <p key={i} className={t.role}><b>{t.role === "user" ? "You" : "CaringU"}:</b> {t.text}</p>)}
            </details>
          )}
        </section>

        <section className={`side ${mobilePane === "side" ? "" : "hide-mobile"}`} aria-label="Family app on Ravi's phone">
          <div className="phone">
            <div className="phone-bar" aria-hidden><span className="phone-notch" /></div>
            <div className="phone-screen"><Family tick={tick} /></div>
          </div>
        </section>
      </div>
      <p className="try-foot muted small">Want to see every step the agent took? Open <a href="#/about#trace">How it's built</a>; this conversation stays here.</p>
    </main>
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
          <p className="muted small">Asked by the CaringU server over MCP (elicitation). It runs only if you approve.</p>
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
        <Stat label={d.checkin?.checked_in ? "Checked in today" : `Not heard from yet (by ${d.checkin?.expected_by ?? "11:00"})`}
          value={d.checkin?.checked_in ? d.checkin.first_at : "—"} tone={!d.checkin?.checked_in && d.checkin?.nudged ? "warn" : undefined} />
      </div>

      {/* Most urgent first: alerts and anything waiting for a decision, then today, then the rest. */}
      <div className="card">
        <h2>Alerts</h2>
        {d.open_alerts.length === 0 ? <p className="muted">All clear.</p> : d.open_alerts.map((a: any) => (
          <AlertCard key={a.id} a={a} me={me} busy={busy === a.id} act={act} />
        ))}
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

      <PaymentsCard me={me} tick={tick} />

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

      <MomentCard me={me} />

      <WeekCard tick={tick} />

      {d.messages_to_her?.length > 0 && (
        <div className="card">
          <h2>Said to her device</h2>
          {d.messages_to_her.map((m: any, i: number) => <p key={i} className="small"><b>{m.at}</b> {m.text} <span className="muted">{m.heard ? "· spoken" : "· waiting"}</span></p>)}
        </div>
      )}

      {d.wellbeing.length > 0 && (
        <div className="card">
          <h2>How she's feeling today</h2>
          {d.wellbeing.map((w: any, i: number) => <p key={i} className={w.red_flag ? "urgent-text" : ""}>{w.at.split(" ")[1]} — “{w.symptoms}”{w.mood ? ` (${w.mood})` : ""}</p>)}
        </div>
      )}
      <StripCard busyKey={busy} setBusyKey={setBusy} />

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

/** Family moments: a photo and a few words, shown and read aloud on her speaker. */
// Safe Pay on the family's phone: approve what the rules sent to the family, finish PayPal
// approvals, link a PayPal account once, and see every payment with the reason for its decision.
const PAY_STATUS: Record<string, string> = { paid: "Paid", awaiting_family: "Needs your approval", awaiting_paypal: "Finish in PayPal",
  refused: "Refused by the rules", declined: "Declined", cancelled: "Cancelled", failed: "Failed", awaiting_her_yes: "Asking her", no_answer: "No answer" };
function PaymentsCard({ me, tick }: { me: string; tick: number }) {
  const [p, setP] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const load = useCallback(async () => { const r = await callTool<any>("list_payments", { limit: 6 }, true); if (r.ok) setP(r.data); }, []);
  useEffect(() => { load(); }, [load, tick]);
  const decide = async (id: string, approve: boolean) => {
    setBusy(id);
    const r = await callTool<any>("decide_payment", { payment_id: id, approve, decided_by: me });
    if (!r.ok) setNote(r.error.message);
    else if (r.data.approve_url) window.open(r.data.approve_url, "_blank", "noopener");
    await load(); setBusy(null);
  };
  const link = async () => {
    setBusy("link");
    const r = await fetch("/api/pay/link", { method: "POST" }).then((x) => x.json()).catch((e) => ({ ok: false, error: String(e) }));
    if (r.ok && r.approve_url) window.open(r.approve_url, "_blank", "noopener"); else setNote(r.error ?? "PayPal link failed");
    setBusy(null);
  };
  if (!p) return null;
  const money = (n: number) => `${p.currency === "USD" ? "$" : p.currency + " "}${Number(n).toFixed(2)}`;
  return (
    <div className="card pay">
      <h2>Payments</h2>
      <p className="small muted">
        Asha can pay {p.payees.map((x: any) => `${x.name} (up to ${money(x.per_payment_limit)})`).join(" and ")} by voice, at most {money(p.daily_limit)} a day.
        Anything else waits for you. PayPal {p.paypal.environment}{p.paypal.configured ? "" : ", not configured yet"}.
      </p>
      {p.payments.length === 0 ? <p className="muted small">No payments yet.</p> : (
        <ul className="pay-list">
          {p.payments.map((x: any) => (
            <li key={x.id} className={`ps-${x.status}`}>
              <div className="pay-main"><b>{money(x.amount)}</b> to {x.payee} <span className="muted small">for {x.purpose} · {x.at.slice(-5)}</span></div>
              <div className="pay-status small"><span className="tag">{PAY_STATUS[x.status] ?? x.status}</span> {x.reasons}</div>
              {x.status === "awaiting_family" && (
                <div className="btns"><button disabled={busy === x.id} onClick={() => decide(x.id, true)}>Approve</button><button className="ghost" disabled={busy === x.id} onClick={() => decide(x.id, false)}>Decline</button></div>
              )}
              {x.status === "awaiting_paypal" && x.approve_url && <a className="button" href={x.approve_url} target="_blank" rel="noreferrer">Pay in PayPal</a>}
            </li>
          ))}
        </ul>
      )}
      <div className="btns">
        {p.paypal.linked_account
          ? <span className="small">Bills are paid from {p.paypal.linked_account}'s PayPal.</span>
          : <button className="ghost" disabled={busy === "link" || !p.paypal.configured} onClick={link}>Link a PayPal account for Asha's bills</button>}
      </div>
      {note && <p className="small warn-text">{note}</p>}
    </div>
  );
}

// The week at a glance. Facts come from the record; "Write it up" asks the configured model
// (Nemotron 3 Ultra on Nebius, or Bedrock) for a warm summary that must pass a grounding check.
function WeekCard({ tick }: { tick: number }) {
  const [w, setW] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { fetch("/api/review/weekly").then((r) => r.json()).then((x) => x.ok && setW((prev: any) => (prev?.written_by && prev.written_by !== "template" ? { ...prev, facts: x.facts } : x))).catch(() => {}); }, [tick]);
  const write = async () => {
    setBusy(true); setErr(null);
    const r = await fetch("/api/review/weekly?write=1").then((x) => x.json()).catch((e) => ({ ok: false, error: String(e) }));
    if (r.ok) setW(r); else setErr(r.error);
    setBusy(false);
  };
  if (!w?.facts) return null;
  const f = w.facts;
  const by = w.model?.includes("Nemotron") ? `NVIDIA ${w.model.split("/").pop()}` : w.model ? `Amazon Bedrock (${w.model})` : "";
  const tokens = (w.usage?.input_tokens ?? 0) + (w.usage?.output_tokens ?? 0);
  return (
    <div className="card week">
      <h2>This week</h2>
      <div className="week-stats">
        <span><b>{f.medicines.adherence_pct ?? "—"}%</b> doses taken</span>
        <span><b>{f.alerts.scams_stopped}</b> {f.alerts.scams_stopped === 1 ? "scam" : "scams"} stopped</span>
        <span><b>{f.check_ins.days_heard_from}/7</b> days heard from</span>
      </div>
      <p className="week-text">{w.review}</p>
      <p className="small muted">{w.written_by === "template"
        ? (w.reason ?? "Plain summary from the record.")
        : `Written by ${by} from the record. Every number was checked against it. ${tokens} tokens, ${(w.ms / 1000).toFixed(1)} s.`}</p>
      <div className="btns"><button className="ghost" onClick={write} disabled={busy}>{busy ? "Writing…" : "Write it up with AI"}</button></div>
      {err && <p className="small warn-text">{err}</p>}
    </div>
  );
}

function MomentCard({ me }: { me: string }) {
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const pick = useRef<HTMLInputElement>(null);
  const share = async () => {
    if (!text.trim()) return;
    setBusy(true); setStatus(null);
    try {
      let photo_id: string | undefined;
      if (file) {
        const blob = await downscale(file, 1600);
        const up = await fetch("/api/vision/photo", { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: blob }).then((r) => r.json());
        if (!up.ok) throw new Error(up.error);
        photo_id = up.photo_id;
      }
      const r = await callTool("send_message_to_elder", { from: me, text: text.trim(), ...(photo_id ? { photo_id } : {}) });
      if (!r.ok) throw new Error(r.error.message);
      setStatus({ ok: true, text: `Sent. Asha's speaker will ${photo_id ? "show it and " : ""}read it out.` });
      setText(""); setFile(null);
    } catch (e: any) { setStatus({ ok: false, text: e?.message ?? String(e) }); }
    setBusy(false);
  };
  return (
    <div className="card moment-card">
      <h2>Share a moment with Asha</h2>
      <p className="muted small">A photo and a few words. Her speaker shows it and reads it out, and she can reply by voice.</p>
      <div className="moment-row">
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Riya's first day at school!" aria-label="Message to Asha" />
        <input ref={pick} type="file" accept="image/*" hidden onChange={(e) => { setFile(e.target.files?.[0] ?? null); e.target.value = ""; }} />
        <button className="ghost" onClick={() => pick.current?.click()}>{file ? "Photo added" : "Add photo"}</button>
        <button disabled={busy || !text.trim()} onClick={share}>{busy ? "Sending…" : "Send to Asha"}</button>
      </div>
      {status && <p className={status.ok ? "claimed" : "warn-text"}>{status.text}</p>}
    </div>
  );
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

// ---------------- How it's built ----------------
const SAFETY_LAYERS = [
  ["Safety screen", "Emergency signs and scam patterns are checked by fixed rules on every message, before any AI sees it."],
  ["Dose check", "Every \"I took my pill\" is recorded and compared with the minimum gap first. A possible second dose gets a question, not a guess."],
  ["Asks before acting", "Refills and appointment changes wait for a yes. The server asks the person itself (MCP elicitation), so the AI cannot approve on her behalf."],
  ["Guards on the AI", "Family-only tools are blocked when Asha is speaking, refills are only offered for medicines that are actually low, and replies that claim an action the system didn't take are corrected."],
  ["Scam Lens", "OpenCV only reads a QR code; fixed rules decide what it means. A payment code sold as a prize or refund, a look-alike bank link, an app download or a crypto request is a scam: the family is alerted and the payee is blocked."],
  ["Escalation with a deadline", "Urgent alerts go to Ravi first, then Neha after 3 minutes, then Asha is told to call 112."],
] as const;

const EVALS = [
  { set: "Scripted cases", n: 32, bedrock: 31, nemotron: 29 },
  { set: "Held-out conversations", n: 24, bedrock: 24, nemotron: 21 },
  { set: "Scenario set", n: 15, bedrock: 15, nemotron: 14 },
];

const GH = "https://github.com/Ohi-Me/CaringU/blob/main/";
// Each part of CaringU by the job it does: which technology, what it is allowed to decide, and the evidence.
const PARTS: { job: string; tech: string; does: string; evidence: string; code: string }[] = [
  { job: "Understanding what she says", tech: "Amazon Bedrock (Nova Pro) · NVIDIA Nemotron 3 Super on Nebius",
    does: "Turns her words into the right action and a short, kind reply. It chooses tools; it never approves anything, and every tool call is checked by fixed rules first.",
    evidence: "Run on both models with the same tests: see How it was tested below.", code: "server/src/agent.ts" },
  { job: "Doing things safely", tech: "Model Context Protocol server (29 tools)",
    does: "Every action is a small tool with checked inputs and an audit log. Refills, appointment changes and payments ask the person for a yes through MCP elicitation, so the AI can't say yes for her.",
    evidence: "Automated tests speak raw JSON-RPC to it, including sessions and approvals.", code: "server/src/mcp.ts" },
  { job: "Seeing what she sees", tech: "OpenCV 5",
    does: "Scam Lens reads a QR code or payment request; the strip check recognises a medicine strip and counts the pills left. OpenCV reports what it sees; fixed rules decide what that means.",
    evidence: "On 640 test photos with blur, glare, distance and tilt, Scam Lens read 99.5% of codes (a plain OpenCV call read 89.7%), with no wrong reads.", code: "vision/carecircle_vision/lens.py" },
  { job: "Reading the small print", tech: "NVIDIA Nemotron 3.5 Super VL",
    does: "Reads the words printed around a code (\"You won… scan to RECEIVE\"). The words are extra evidence for the scam rules: they can make a warning stronger, never clear one.",
    evidence: "Automated tests cover a prize flyer, a fake KYC message and a genuine pharmacy bill.", code: "server/src/lens.ts" },
  { job: "Paying bills without being tricked", tech: "PayPal (sandbox): Orders v2 and Vault",
    does: "She can pay approved payees within the limits her family set. A new payee or a larger amount waits for Ravi; a payee Scam Lens flagged is refused. PayPal moves the money only after that.",
    evidence: "Automated tests cover paying on her yes, family approval above the limit, and refusal of a blocked payee.", code: "server/src/pay.ts" },
  { job: "Keeping the family in the loop", tech: "NVIDIA Nemotron 3 Ultra · Amazon Bedrock",
    does: "Writes a short weekly update from the record. Fixed code gathers the facts; the model only words them, and a check rejects any number that isn't in the record.",
    evidence: "A test review that invented a number was rejected and the plain version was shown instead.", code: "server/src/review.ts" },
];

function Parts() {
  return (
    <section aria-labelledby="parts-title">
      <h2 id="parts-title">What each part does, and how we know it works</h2>
      <div className="parts">
        {PARTS.map((p) => (
          <article key={p.job} className="part">
            <h3>{p.job}</h3>
            <p className="part-tech">{p.tech}</p>
            <p>{p.does}</p>
            <p className="part-evidence">{p.evidence}</p>
            <a className="small" href={GH + p.code} target="_blank" rel="noreferrer">Read the code</a>
          </article>
        ))}
      </div>
    </section>
  );
}

function About({ events }: { events: TraceEvent[] }) {
  const [mode, setMode] = useState<ModeInfo | null>(null);
  const [health, setHealth] = useState<any>(null);
  useEffect(() => {
    fetch("/api/agent/mode").then((r) => r.json()).then(setMode).catch(() => setMode(null));
    fetch("/api/health").then((r) => r.json()).then(setHealth).catch(() => setHealth(null));
    if (location.hash.includes("#trace")) document.getElementById("trace")?.scrollIntoView();
  }, []);
  const model = !mode ? "offline" : mode.effective === "bedrock" ? "Amazon Bedrock" : mode.effective === "nebius" ? "NVIDIA Nemotron" : "rule-based planner";
  return (
    <main className="about">
      <section className="about-intro">
        <h1>How CaringU is built</h1>
        <p className="lead">A language model handles the conversation. Everything that could hurt someone, like a double dose, a scam or a missed emergency, is decided by fixed code that is tested on its own.</p>
      </section>

      <section aria-labelledby="flow-title">
        <h2 id="flow-title">From her words to a safe answer</h2>
        <ol className="flow">
          <li><h3>Her speaker or the family app</h3><p>Voice in the browser (Web Speech API), or typing. The family app talks to the server directly.</p></li>
          <li><h3>Safety screen</h3><p>Fixed rules for emergencies and scams. Urgent cases are answered here, without the model.</p></li>
          <li><h3>Agent</h3><p>Amazon Bedrock (Nova Pro), or NVIDIA Nemotron on Nebius, with guards on every tool call. If the model fails, a rule-based planner answers.</p></li>
          <li><h3>MCP server</h3><p>29 care tools over Streamable HTTP. Approvals are asked of the person through MCP elicitation.</p></li>
          <li><h3>Care record and payments</h3><p>Medicines, doses, appointments, alerts and messages in SQLite. Payments go through PayPal (sandbox) only after the payment rules allow them. Photos go to an OpenCV 5 service that reads QR codes and payment requests (Scam Lens), and recognises a medicine strip and counts the pills left.</p></li>
        </ol>
        <p className="status small">
          Live now: <b>{model}</b>{mode?.model ? ` (${mode.model})` : ""}; MCP {health?.protocol ?? "offline"}; camera checks (OpenCV) {health?.vision?.ok ? "online" : "offline"}.
        </p>
      </section>

      <Parts />

      <section aria-labelledby="safety-title">
        <h2 id="safety-title">Safety is fixed code, not AI</h2>
        <dl className="layers">
          {SAFETY_LAYERS.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
        </dl>
      </section>

      <section aria-labelledby="eval-title">
        <h2 id="eval-title">How it was tested</h2>
        <table className="evals">
          <thead><tr><th scope="col">Test set</th><th scope="col">Amazon Bedrock</th><th scope="col">NVIDIA Nemotron</th></tr></thead>
          <tbody>
            {EVALS.map((e) => <tr key={e.set}><th scope="row">{e.set}</th><td>{e.bedrock} of {e.n}</td><td>{e.nemotron} of {e.n}</td></tr>)}
          </tbody>
        </table>
        <p className="small muted">These are real model runs. The test cases were written by the builder, and some held-out cases were seen before fixes, so they are not an independent benchmark. The failed cases and their causes are in the reports on GitHub. 62 automated tests cover the server without a model, including Scam Lens end to end and the weekly review's grounding check. Camera results are in docs/lens-eval.md.</p>
      </section>

      <section id="trace" aria-labelledby="trace-title">
        <h2 id="trace-title">What happened in your demo</h2>
        <Trace events={events} />
      </section>

      <section className="builder" aria-labelledby="builder-title">
        <h2 id="builder-title">Who built it</h2>
        <p>Designed and built by <b>Rohit Kumar</b>.</p>
        <p><a href="https://github.com/Ohi-Me/CaringU" target="_blank" rel="noreferrer">Source code on GitHub</a></p>
      </section>
    </main>
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
        <p className="muted small">Every line is a real JSON-RPC message to the CaringU MCP server over Streamable HTTP, from the agent (server side) or this dashboard (browser).</p>
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
  if (by.mode === "lens-check") return "Checked by Scam Lens: OpenCV read the code, fixed rules judged it (no model involved)";
  if (by.mode === "nebius") return `Answered by NVIDIA Nemotron on Nebius (${by.model})`;
  if (by.mode === "nebius-partial") return `Nemotron failed part-way (${by.fallback?.reason}); no retry, to avoid duplicate actions`;
  if (by.mode === "bedrock") return `Answered by Amazon Bedrock (${by.model})`;
  if (by.mode === "bedrock-partial") return `Bedrock failed part-way (${by.fallback?.reason}); no retry, to avoid duplicate actions`;
  if (by.fallback) return `Rule-based fallback: ${by.fallback.from === "nebius" ? "Nemotron" : "Bedrock"} unavailable (${by.fallback.reason})`;
  return "Answered by the rule-based planner";
}
