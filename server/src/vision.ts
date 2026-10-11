// Strip check: photos of medicine blister strips are analysed by the OpenCV 5 vision
// service; this module stores photos, calls the service and reconciles what the strip
// shows with the dose log. The reconciliation (not the language model) decides when a
// possible double dose is an emergency.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DB } from "./db.js";
import { findMedication, localStamp, raiseAlert, ToolError } from "./care.js";

const VISION_URL = process.env.VISION_URL ?? "http://127.0.0.1:8790";
export const PHOTO_DIR = resolve(process.env.PHOTO_DIR ?? "data/photos");
mkdirSync(PHOTO_DIR, { recursive: true });

type Row = Record<string, any>;
const PHOTO_ID = /^ph_[a-f0-9]{12}$/;

export function savePhoto(bytes: Buffer): string {
  if (bytes.length < 100) throw new ToolError("EMPTY_PHOTO", "The photo is empty.");
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
  if (!isJpeg && !isPng) throw new ToolError("UNSUPPORTED_PHOTO", "Send a JPEG or PNG photo.");
  const id = `ph_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  writeFileSync(join(PHOTO_DIR, `${id}.img`), bytes);
  return id;
}

export function photoPath(id: string, annotated = false) {
  if (!PHOTO_ID.test(id)) return null;
  const p = join(PHOTO_DIR, annotated ? `${id}_annotated.jpg` : `${id}.img`);
  return existsSync(p) ? p : null;
}

function readPhoto(id: string) {
  const p = photoPath(id);
  if (!p) throw new ToolError("PHOTO_NOT_FOUND", `No photo ${id}. Upload it first.`);
  return readFileSync(p);
}

async function callVision(path: string, form: FormData) {
  let res: Response;
  try {
    res = await fetch(`${VISION_URL}${path}`, { method: "POST", body: form, signal: AbortSignal.timeout(30_000) });
  } catch (e: any) {
    throw new ToolError("VISION_UNAVAILABLE", `The vision service is not reachable (${e?.name ?? "error"}). Nothing was recorded.`, true);
  }
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new ToolError("VISION_ERROR", `Vision service: ${body?.detail ?? res.status}`, res.status >= 500);
  return body;
}

export async function visionHealth() {
  try {
    const r = await fetch(`${VISION_URL}/health`, { signal: AbortSignal.timeout(3000) });
    return r.ok ? await r.json() : { ok: false };
  } catch {
    return { ok: false };
  }
}

export async function registerStrip(db: DB, photoId: string, medicationRef: string, total: number, pillsInStrip?: number, rows?: number) {
  const med = findMedication(db, medicationRef);
  const form = new FormData();
  form.append("image", new Blob([readPhoto(photoId)]), "ref.jpg");
  form.append("name", `${med.name} ${med.dose}`);
  form.append("total", String(total));
  form.append("medication_id", med.id);
  if (rows) form.append("rows", String(rows));
  if (pillsInStrip !== undefined) form.append("pills_in_reference", String(pillsInStrip));
  const r = await callVision("/register", form);
  if (r.preview_jpeg_b64) writeFileSync(join(PHOTO_DIR, `${photoId}_annotated.jpg`), Buffer.from(r.preview_jpeg_b64, "base64"));
  return {
    registered: `${med.name} ${med.dose}`, medication_id: med.id, cavities: r.total, rows: r.rows, keypoints: r.keypoints,
    preview: `/api/vision/photo/${photoId}/annotated`,
    warning: r.keypoints_warning ? "Few visual features: take the reference photo flat, in good light, with the printed side visible." : null,
  };
}

/**
 * Inspect a strip photo and reconcile it with the dose log since the previous check:
 *   pills newly gone == doses recorded  -> consistent
 *   one more gone than recorded         -> probably taken but not recorded (ask before recording)
 *   two+ more gone, or one more gone while a dose is already recorded within the minimum gap
 *                                       -> possible double dose: URGENT family alert (deterministic)
 *   fewer gone than recorded            -> maybe taken from another strip (informational)
 */
export async function inspectStrip(db: DB, now: Date, photoId: string) {
  const form = new FormData();
  form.append("image", new Blob([readPhoto(photoId)]), "photo.jpg");
  const v = await callVision("/inspect", form);
  if (v.annotated_jpeg_b64) writeFileSync(join(PHOTO_DIR, `${photoId}_annotated.jpg`), Buffer.from(v.annotated_jpeg_b64, "base64"));
  const evidence = {
    annotated_image: v.annotated_jpeg_b64 ? `/api/vision/photo/${photoId}/annotated` : null,
    opencv: v.opencv, timing_ms: v.timing?.total_ms, match: v.match ?? null,
  };
  if (!v.recognised) {
    return { recognised: false, reason: v.reason, evidence, guidance: "Say you couldn't recognise the strip. Suggest holding it flat, closer, in good light, printed side up. Never guess the medicine." };
  }
  const med = v.medication_id ? (() => { try { return findMedication(db, v.medication_id); } catch { return null; } })() : null;
  if (!med) return { recognised: true, medication: v.name, reason: "This strip is registered but not linked to a current medication.", evidence };

  const prev = db.prepare("SELECT * FROM strip_checks WHERE medication_id=? AND ref_id=? ORDER BY at DESC LIMIT 1").get(med.id, v.ref_id) as Row | undefined;
  const remaining: number = v.pills_remaining;
  let verdict: string, message: string, unrecorded = 0, alert = null;
  let suggest_record = false;
  if (!prev || remaining > prev.remaining) {
    verdict = "baseline";
    message = prev ? "More pills than at the last check, so this looks like a new strip. I'll compare from now on." : "First check of this strip. I'll compare with it next time.";
  } else {
    const newlyEmpty = prev.remaining - remaining;
    const recorded = (db.prepare("SELECT COUNT(*) n FROM dose_log WHERE medication_id=? AND taken_at > ?").get(med.id, prev.at) as Row).n as number;
    unrecorded = newlyEmpty - recorded;
    const last = db.prepare("SELECT taken_at FROM dose_log WHERE medication_id=? ORDER BY taken_at DESC LIMIT 1").get(med.id) as Row | undefined;
    const recentDose = last && now.getTime() - new Date(last.taken_at).getTime() < med.min_gap_hours * 3_600_000;
    if (unrecorded <= 0) {
      verdict = unrecorded === 0 ? "consistent" : "fewer_gone_than_recorded";
      message = unrecorded === 0
        ? `The strip matches the record: ${newlyEmpty} gone since the last check, ${recorded} recorded.`
        : `${recorded} doses are recorded but only ${newlyEmpty} pills are gone from this strip; maybe some came from another strip.`;
    } else if (unrecorded >= 2 || recentDose) {
      verdict = "possible_double_dose";
      message = `${newlyEmpty} ${med.name} gone from the strip since ${localStamp(prev.at)}, but only ${recorded} recorded${recentDose ? `, and a dose is already recorded at ${localStamp(last!.taken_at)}` : ""}.`;
      alert = raiseAlert(db, now, "urgent", "strip_double_dose", `Strip check: ${message} Possible extra dose. Please call her.`);
    } else {
      verdict = "unrecorded_dose";
      suggest_record = true;
      message = `One more ${med.name} is gone than recorded since ${localStamp(prev.at)}. It was probably taken but not logged.`;
    }
  }
  const checkId = `sc_${randomUUID().slice(0, 8)}`;
  db.prepare("INSERT INTO strip_checks (id, at, medication_id, ref_id, remaining, total, photo_id, verdict) VALUES (?,?,?,?,?,?,?,?)")
    .run(checkId, now.toISOString(), med.id, v.ref_id, remaining, v.total_cavities, photoId, verdict);
  return {
    recognised: true, check_id: checkId, medication: `${med.name} ${med.dose}`, medication_id: med.id,
    pills_remaining: remaining, total_cavities: v.total_cavities, verdict, message, unrecorded_doses: Math.max(0, unrecorded),
    suggest_record_dose: suggest_record, family_alerted: !!alert, notified: alert?.notified ?? [], evidence,
    guidance: verdict === "possible_double_dose"
      ? "Tell her not to take any more of this medicine today, to call her pharmacist or doctor, and to call 112 if she feels faint, dizzy or unwell. Family has been alerted."
      : suggest_record ? "Ask whether she took it; record it only if she says yes (record_dose)." : "Report the result briefly.",
  };
}

export function recentStripChecks(db: DB, limit = 6) {
  return (db.prepare("SELECT s.*, m.name FROM strip_checks s LEFT JOIN medications m ON m.id = s.medication_id ORDER BY s.at DESC LIMIT ?").all(limit) as Row[])
    .map((s) => ({ at: localStamp(s.at), medication: s.name, remaining: s.remaining, total: s.total, verdict: s.verdict,
      image: `/api/vision/photo/${s.photo_id}/annotated` }));
}
