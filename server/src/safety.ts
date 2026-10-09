// Deterministic safety screens. They run on EVERY utterance, before and
// independently of the agent, so an emergency or a scam is never missed just
// because the planner/LLM routed the request somewhere else.
//
// Triage follows widely published first-aid red flags (FAST stroke signs,
// chest pain, breathing difficulty, loss of consciousness, serious falls,
// heavy bleeding, low blood sugar in someone on diabetes medicine). It is a
// conservative escalation aid, not a diagnosis.

export type Triage = "urgent" | "watch" | "routine";
export interface TriageResult { triage: Triage; signals: string[] }

// ---------- clause handling: negation and third-party mentions ----------
const NEGATION = /\b(no|not|don'?t|doesn'?t|didn'?t|never|without|isn'?t|aren'?t|wasn'?t|haven'?t|hasn'?t|no longer|anymore|nahi|nahin)\b/i;
const THIRD_PARTY = /\b(my (friend|neighbou?r|husband|wife|sister|brother|cousin|colleague|dog|cat)|(a|the) (movie|film|show|book|story|news)|someone else|he|she|they|his|her)\b/i;
const FIRST_PERSON = /\b(i|i'?m|i'?ve|me|my|mine|myself|maine|mujhe|mera|meri)\b/i;

function clauses(text: string) {
  return text.toLowerCase().split(/[.;!?]+|,|\bbut\b|\bthough\b|\bhowever\b/).map((c) => c.trim()).filter(Boolean);
}

/** A pattern counts in a clause unless it is negated before the match, or the clause is about someone else. */
function affirmed(clause: string, re: RegExp) {
  const m = re.exec(clause);
  if (!m) return false;
  const before = clause.slice(0, m.index);
  if (NEGATION.test(before) || /\b(any ?more|anymore|no more)\b/.test(clause.slice(m.index))) return false;
  if (THIRD_PARTY.test(before) && !FIRST_PERSON.test(before.replace(THIRD_PARTY, ""))) return false;
  if (/\b(about|watched|read|heard about|news about|movie about)\b/.test(before)) return false;
  return true;
}

type Rule = [RegExp, string];

const URGENT: Rule[] = [
  // Stroke (FAST)
  [/\b(face|mouth|smile)\b.{0,25}\b(droop\w*|numb|strange|weird|lopsided|fallen)\b|\b(droop\w*|lopsided)\b.{0,15}\bface\b/, "possible stroke: face"],
  [/\b(can'?t|cannot|unable to) (move|lift|feel)\b.{0,20}\b(arm|leg|hand|side)\b|\b(arm|leg|hand|one side)\b.{0,20}\b(numb|weak|dead|heavy|won'?t move)\b|\bnumb(ness)?\b.{0,20}\bone side\b/, "possible stroke: one-sided weakness"],
  [/\b(slurr\w*|words?\b.{0,20}\b(wrong|funny|jumbled|won'?t come|coming out)|can'?t (speak|talk|get (the|my) words)|speech\b.{0,15}\b(strange|wrong|slurred))/, "possible stroke: speech"],
  [/\b(sudden(ly)?\b.{0,25}\b(can'?t see|lost? (my )?(sight|vision)|blind)|can'?t see out of)\b/, "sudden vision loss"],
  [/\b(worst headache|sudden(ly)? (severe|terrible|very bad) headache|thunderclap)\b/, "sudden severe headache"],
  // Heart
  [/\bchest\b.{0,25}\b(pain|pressure|tight\w*|heav\w*|crush\w*|squeez\w*|hurts?)\b|\b(pain|pressure|tight\w*|heav\w*)\b.{0,25}\bchest\b/, "chest pain/pressure"],
  [/\b(pain|ache)\b.{0,30}\b(spread\w*|going|radiat\w*)\b.{0,20}\b(arm|jaw|neck|back)\b/, "pain spreading to arm/jaw"],
  // Breathing
  [/\b(can'?t|cannot|hard to|difficult to|struggling to|trouble) (breathe|breathing)|\b(short(ness)? of breath|breathless|gasping|choking)\b/, "breathing difficulty"],
  // Consciousness
  [/\b(fainted|passed out|blacked out|black(ing)? out|lost consciousness|unconscious|collapsed)\b/, "loss of consciousness"],
  [/\b(confused|confusion|don'?t know where i am|disoriented)\b/, "new confusion"],
  // Falls with injury / unable to get up
  [/\b(fell|fallen|fall|slipped)\b.{0,40}\b(can'?t (get|stand) up|cannot (get|stand) up|hit (my )?head|bleeding|broke|broken|can'?t move)\b/, "fall with injury or unable to get up"],
  [/\bhit (my )?head\b.{0,40}\b(sleepy|drowsy|vomit\w*|confus\w*|dizzy)\b/, "head injury with warning signs"],
  // Bleeding
  [/\b(cough\w*|vomit\w*|throw\w* up|spit\w*) (up )?blood\b|\b(heavy|won'?t stop|lot of) bleed\w*|\bbleeding (heavily|a lot)\b/, "serious bleeding"],
  // Allergy / seizure
  [/\b(throat|tongue|lips?|face)\b.{0,20}\bswell\w*|\bswell\w*.{0,20}\b(throat|tongue|lips)\b/, "possible severe allergic reaction"],
  [/\b(seizure|having a fit|convuls\w*)\b/, "seizure"],
  [/\b(heart attack|having a stroke)\b/, "suspected heart attack or stroke"],
];

const WATCH: Rule[] = [
  [/\b(dizz\w*|light-?headed|spinning|unsteady|faint(ish)?|giddy|chakkar)\b/, "dizziness"],
  [/\b(heart (is )?(racing|pounding|fluttering)|palpitations?)\b/, "palpitations"],
  [/\b(shak\w*|trembl\w*|sweat\w*|clammy)\b/, "shaky/sweaty (low sugar?)"],
  [/\b(ache|aching|aches|pain|painful|hurts?|sore)\b/, "pain"],
  [/\b(fever|temperature|chills|bukhar)\b/, "fever"],
  [/\b(cough\w*|a cold|caught (a )?cold|runny nose|sore throat)\b/, "cough/cold"],
  [/\b(nause\w*|vomit\w*|throw\w* up|diarrh\w*|loose motion\w*)\b/, "stomach upset"],
  [/\b(not (felt like )?eating|no appetite|haven'?t (felt like )?eat\w*|lost (my )?appetite|can'?t eat)\b/, "poor appetite"],
  [/\b(can'?t sleep|couldn'?t sleep|insomnia|no sleep|didn'?t sleep)\b/, "poor sleep"],
  [/\b(lonely|sad|depress\w*|anxious|nobody (has )?visit\w*|udaas)\b/, "low mood/loneliness"],
  [/\b(swollen|swelling)\b/, "swelling"],
  [/\b(fell|fall|fallen|slipped|tripped)\b/, "fall"],
  [/\b(bruise|cut myself|small cut)\b/, "minor injury"],
  [/\b(headache|migraine)\b/, "headache"],
  [/\b(tired|weak|no energy|exhausted)\b/, "tiredness"],
  [/\b(blood in (my )?(urine|stool|pee))\b/, "blood in urine/stool"],
];

/** Low blood sugar warning: shaky/sweaty plus confusion/faintness is urgent for someone on diabetes medicine. */
const HYPO_SEVERE = /\b(shak\w*|trembl\w*|sweat\w*)\b[\s\S]*\b(confus\w*|faint\w*|drowsy|can'?t think|blurr\w*)\b|\b(confus\w*|faint\w*)\b[\s\S]*\b(shak\w*|sweat\w*)\b/;
const EXTRA_DOSE_UNWELL = /\b(twice|double|two (doses|tablets|pills)|extra (dose|pill|tablet)|too many)\b[\s\S]*\b(faint|dizzy|unwell|sick|strange|weak)\b/;

export function triageText(text: string): TriageResult {
  const cs = clauses(text);
  const urgent = URGENT.filter(([re]) => cs.some((c) => affirmed(c, re))).map(([, l]) => l);
  const whole = text.toLowerCase();
  if (!NEGATION.test(whole.split(/\b(shak|sweat|trembl)/)[0] ?? "") && HYPO_SEVERE.test(whole)) urgent.push("possible low blood sugar with confusion/faintness");
  if (EXTRA_DOSE_UNWELL.test(whole) && !/\bnot (faint|dizzy|unwell)/.test(whole)) urgent.push("possible extra dose and feeling unwell");
  if (urgent.length) return { triage: "urgent", signals: [...new Set(urgent)] };
  const watch = WATCH.filter(([re]) => cs.some((c) => affirmed(c, re))).map(([, l]) => l);
  // "fell ... but I'm okay" style minor falls are watch, and a fall mentioned about someone else is dropped by affirmed().
  return watch.length ? { triage: "watch", signals: [...new Set(watch)] } : { triage: "routine", signals: [] };
}

// ---------- scam screen ----------
export type ScamVerdict = "likely_scam" | "suspicious" | "no_strong_signals";
export interface ScamResult { risk_score: number; verdict: ScamVerdict; signals: string[]; protective: string[]; in_progress: boolean; scam_type: string | null }

const ASK = /\b(ask\w*|want\w*|need\w*|tell (him|her|them)|share|give|read (out|him|her|them)?|send|enter|type|said i (must|should|have to)|told me to|wants? me to|asking for|demand\w*)\b/;
type ScamRule = { re: RegExp; w: number; label: string; strong?: boolean; type?: string; needsAsk?: boolean };
const SCAM: ScamRule[] = [
  { re: /\b(otp|one[- ]time (pass)?(word|code)|verification code|the code|pin|cvv|3[- ]digit|three digit|number on the back|card number|card details|password|upi pin)\b/, w: 40, label: "asks for a secret code, PIN or card details", strong: true, needsAsk: true, type: "credential theft" },
  { re: /\b(gift ?cards?|play ?cards?|google play|itunes|amazon (pay )?cards?|crypto|bitcoin|usdt|wire transfer|western union|moneygram)\b/, w: 35, label: "unusual payment method (gift cards / crypto / wire)", strong: true, type: "payment scam" },
  { re: /\b(anydesk|any desk|teamviewer|quick ?support|rustdesk|remote (access|app|control)|screen ?shar\w*|install (an |this |the )?app|download (an |this |the )?app)\b/, w: 40, label: "asks to install remote-access software", strong: true, type: "remote access scam" },
  { re: /\b(scan (a|the|this) qr|qr code to (receive|get|claim))\b/, w: 40, label: "QR code to 'receive' money (scanning a QR sends money)", strong: true, type: "QR scam" },
  { re: /\b(processing fee|customs (charge|duty|fee)|release fee|registration fee|fee to (claim|release|receive)|pay \w* ?to claim|tax on (the )?prize)\b/, w: 35, label: "pay a fee to receive a prize or parcel", strong: true, type: "advance-fee scam" },
  { re: /\b(police|cbi|ed officer|narcotics|customs|income ?tax|tax department|irs|court|judge|trai|cyber cell|crime branch|rbi)\b/, w: 20, label: "claims to be police / government / regulator", type: "impersonation" },
  { re: /\b(arrest\w*|digital arrest|warrant|case against|illegal activity|drugs|money laundering|jail|legal action)\b/, w: 25, label: "threat of arrest or legal trouble" },
  { re: /\b(stay on the (call|line|video)|don'?t (hang up|disconnect)|video call\b.{0,40}\b(uniform|police|officer))\b/, w: 30, label: "keeps you on the call (digital-arrest pattern)", strong: true, type: "digital arrest" },
  { re: /\b(grand(son|daughter|child)|nephew|niece|son|daughter|[A-Z]?\w+'s friend|it'?s me)\b[\s\S]{0,80}\b(accident|hospital|jail|bail|police|stuck|arrested|in trouble|phone (broke|is broken|lost)|new number)\b/, w: 30, label: "family member in an emergency or on a new number", type: "family-emergency scam" },
  { re: /\b(send|transfer|pay|need\w*)\b[\s\S]{0,40}\b(money|rupees|rs\.?|₹|\d{3,}|lakh|dollars|\$)\b|\b(money|rupees|lakh)\b[\s\S]{0,30}\b(urgent\w*|immediately|right now|new number)\b/, w: 20, label: "asks you to send money" },
  { re: /\b(won|winner|lottery|prize|kbc|lucky draw|jackpot|cashback|refund|reward)\b/, w: 15, label: "prize, refund or cashback lure", type: "prize/refund lure" },
  { re: /\b(urgent\w*|immediately|right now|today|tonight|within (\d+|an?|one|two|24) ?(hours?|minutes?|hrs?)|in (\d+|two|2) hours|last chance|offer ends)\b/, w: 10, label: "pressure to act fast" },
  { re: /\b(will be|would be|is going to be|be) (blocked|suspended|frozen|closed|cut|disconnected|stopped|cancelled|deactivated)\b|\b(power|electricity|pension|account|number|sim)\b.{0,30}\b(cut|stop\w*|block\w*|disconnect\w*|suspend\w*)\b/, w: 20, label: "threat that a service or account will be cut off" },
  { re: /\b(don'?t|do not|not to) (tell|inform) (anyone|anybody|his parents|her parents|your family|your son|your daughter|the bank)|\bkeep (this|it) (a )?secret\b|\bshould not tell anyone\b/, w: 30, label: "asks you to keep it secret", strong: true },
  { re: /\b(open|click|tap) (a|the|this|on the)? ?link|https?:\/\/|bit\.ly|tinyurl|click here\b/, w: 15, label: "asks you to open a link" },
  { re: /\b(update|verify|confirm) (your |my )?(kyc|details|account|payment|life certificate|pan|aadhaar)\b/, w: 20, label: "asks you to 'update/verify' details" },
  { re: /\b(double your|guaranteed (returns|profit)|invest\w*\b.{0,30}\b(scheme|crypto|returns))\b/, w: 30, label: "too-good-to-be-true investment", strong: true, type: "investment scam" },
  { re: /\b(unknown number|new number|number i don'?t know)\b/, w: 15, label: "unknown or new number" },
  { re: /\b(customer care|helpline) number\b.{0,30}\b(found )?online\b|\bnumber i found (online|on google)\b/, w: 20, label: "customer-care number found online" },
  { re: /\b(upi (id|number)|account number he gave|his account|this account|pay \d+ on)\b/, w: 20, label: "pay to a personal account / UPI id" },
];

// Signs a message is a legitimate notification. They lower the score but never cancel a strong signal.
const PROTECTIVE: [RegExp, string][] = [
  [/\b(do not|don'?t|never) share (it|this|your|the)\b/, "the message itself warns not to share codes"],
  [/\b(call (the|us on the) (number|helpline) on the back of your card|official (app|website|number)|at the (office|branch)|visit the branch)\b/, "points you to the official channel"],
  [/\b(ready for pick-?up|has been shipped|is out for delivery|appointment (tomorrow|on)|confirm(ing)? (my|your) appointment|order of)\b/, "routine service notice"],
];
const IN_PROGRESS = /\b(still on the (line|phone|call)|on the (line|phone|call) (now|right now)|is on the phone|waiting on the (line|phone)|he'?s waiting|she'?s waiting|they'?re waiting|right now on)\b/;

export function screenScam(text: string): ScamResult {
  const t = text.toLowerCase();
  const askPresent = ASK.test(t);
  const hits = SCAM.filter((r) => r.re.test(t) && (!r.needsAsk || askPresent));
  const protective = PROTECTIVE.filter(([re]) => re.test(t)).map(([, l]) => l);
  let score = hits.reduce((s, r) => s + r.w, 0) - protective.length * 25;
  const strong = hits.some((r) => r.strong);
  // Authority + threat together is the core of impersonation and digital-arrest scams.
  const authority = hits.some((r) => r.label.startsWith("claims to be police"));
  const threat = hits.some((r) => r.label.startsWith("threat"));
  if (authority && threat) score += 20;
  score = Math.max(0, Math.min(100, score));
  const verdict: ScamVerdict = (strong && score >= 35) || score >= 50 ? "likely_scam" : score >= 25 ? "suspicious" : "no_strong_signals";
  return {
    risk_score: score, verdict, signals: hits.map((h) => h.label), protective,
    in_progress: IN_PROGRESS.test(t),
    scam_type: verdict === "no_strong_signals" ? null : (hits.find((h) => h.type && h.strong)?.type ?? hits.find((h) => h.type)?.type ?? "unknown"),
  };
}

/** Does the utterance describe a call/message at all? (Used only to decide whether to run the scam screen tool.) */
export const MENTIONS_CONTACT = /\b(call(ed|er|ing)?|phone|rang|message|sms|text|email|e-mail|whatsapp|video call|link|someone|a man|a woman|a lady|courier|said he|said she|says he|says she|claiming)\b/i;
