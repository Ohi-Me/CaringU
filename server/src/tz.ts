// The care record runs on Asha's local time (her home is in India in the demo), whatever zone
// the server's clock uses. Imported first, before anything reads the time. Override with CARE_TZ.
process.env.TZ ||= process.env.CARE_TZ || "Asia/Kolkata";
export const CARE_PLACE = process.env.CARE_PLACE ?? "India";
