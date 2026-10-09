// SQLite persistence (Node's built-in node:sqlite, no native build step).
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DB = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('elder','caregiver')),
  relation TEXT, phone TEXT, sample INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS medications (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, dose TEXT NOT NULL, purpose TEXT,
  times TEXT NOT NULL,              -- JSON array of "HH:MM"
  min_gap_hours REAL NOT NULL,      -- doses closer than this are a double-dose risk
  pills_left INTEGER NOT NULL, pills_per_dose INTEGER NOT NULL DEFAULT 1,
  with_food INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, sample INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS dose_log (
  id TEXT PRIMARY KEY, medication_id TEXT NOT NULL REFERENCES medications(id),
  taken_at TEXT NOT NULL, recorded_by TEXT NOT NULL, note TEXT
);
CREATE TABLE IF NOT EXISTS appointments (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, starts_at TEXT NOT NULL, location TEXT,
  with_whom TEXT, transport TEXT, notes TEXT, status TEXT NOT NULL DEFAULT 'scheduled', sample INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS wellbeing (
  id TEXT PRIMARY KEY, at TEXT NOT NULL, mood TEXT, symptoms TEXT, red_flag INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY, at TEXT NOT NULL, severity TEXT NOT NULL CHECK (severity IN ('info','warning','urgent')),
  kind TEXT NOT NULL, message TEXT NOT NULL, acknowledged_by TEXT, acknowledged_at TEXT
);
CREATE TABLE IF NOT EXISTS pending_actions (
  id TEXT PRIMARY KEY, at TEXT NOT NULL, action TEXT NOT NULL, payload TEXT NOT NULL,
  summary TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'awaiting_confirmation', resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS refills (
  id TEXT PRIMARY KEY, medication_id TEXT NOT NULL REFERENCES medications(id), at TEXT NOT NULL,
  quantity INTEGER NOT NULL, pharmacy TEXT NOT NULL, status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, tool TEXT NOT NULL, args TEXT,
  ok INTEGER NOT NULL, code TEXT, latency_ms REAL NOT NULL
);
`;

export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
