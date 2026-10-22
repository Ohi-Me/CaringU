// Natural voices for the speaker: Amazon Polly (generative engine first, then neural).
// CaringU itself speaks with one warm Indian-English female voice; a family member's own words
// can be read in a voice that matches them. If Polly isn't available (no permission, no network),
// the browser falls back to its own best voice.
import { PollyClient, SynthesizeSpeechCommand, type Engine, type VoiceId } from "@aws-sdk/client-polly";

export const ttsEnabled = () => process.env.TTS_PROVIDER === "polly";
const VOICES: Record<"female" | "male", { id: string; lang?: string }> = {
  female: { id: process.env.TTS_VOICE_FEMALE ?? "Kajal", lang: process.env.TTS_LANG_FEMALE ?? "en-IN" },
  male: { id: process.env.TTS_VOICE_MALE ?? "Matthew", lang: process.env.TTS_LANG_MALE },
};
const polly = new PollyClient({ region: process.env.AWS_REGION ?? "us-east-1" });
const cache = new Map<string, Buffer>();
let pausedUntil = 0;

export async function synthesize(text: string, kind: "female" | "male") {
  if (!ttsEnabled() || Date.now() < pausedUntil) return null;
  const clean = text.replace(/\s+/g, " ").trim().slice(0, 1500);
  const v = VOICES[kind];
  const key = `${v.id}|${clean}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let last: any = null;
  for (const engine of ["generative", "neural"] as Engine[]) {
    try {
      const out = await polly.send(new SynthesizeSpeechCommand({ Engine: engine, VoiceId: v.id as VoiceId, OutputFormat: "mp3", Text: clean,
        ...(v.lang ? { LanguageCode: v.lang as any } : {}) }));
      const buf = Buffer.from(await out.AudioStream!.transformToByteArray());
      if (cache.size > 200) cache.delete(cache.keys().next().value!);
      cache.set(key, buf);
      return buf;
    } catch (e: any) {
      last = e;
      // No permission or no credentials: stop asking for a while; the browser voice takes over.
      if (/AccessDenied|UnrecognizedClient|CredentialsProvider|Could not load credentials/i.test(`${e?.name} ${e?.message}`)) { pausedUntil = Date.now() + 10 * 60_000; break; }
    }
  }
  console.error("[tts]", last?.name, String(last?.message ?? "").slice(0, 120));
  return null;
}
