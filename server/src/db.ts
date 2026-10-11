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
  taken_at TEXT NOT NULL, recorded_by TEXT NOT NULL, note TEXT,
  extra INTEGER NOT NULL DEFAULT 0   -- 1 = recorded inside the minimum gap after the user confirmed an extra dose
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
  // Additive migrations for databases created by earlier versions.
  addColumn(db, "dose_log", "extra", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "people", "priority", "INTEGER");               // escalation order for caregivers (1 = first)
  addColumn(db, "alerts", "escalation_level", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "alerts", "next_escalation_at", "TEXT");
  addColumn(db, "alerts", "claimed_by", "TEXT");                 // caregiver who said "I'm calling her" etc.
  addColumn(db, "alerts", "claimed_action", "TEXT");
  db.exec(`
    CREATE TABLE IF NOT EXISTS alert_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, alert_id TEXT NOT NULL, at TEXT NOT NULL, event TEXT NOT NULL, detail TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, at TEXT NOT NULL, from_name TEXT NOT NULL, to_elder INTEGER NOT NULL DEFAULT 1,
      text TEXT NOT NULL, alert_id TEXT, heard_at TEXT
    );
    CREATE TABLE IF NOT EXISTS strip_checks (
      id TEXT PRIMARY KEY, at TEXT NOT NULL, medication_id TEXT NOT NULL, ref_id TEXT NOT NULL,
      remaining INTEGER NOT NULL, total INTEGER NOT NULL, photo_id TEXT NOT NULL, verdict TEXT NOT NULL
    );`);
  return db;
}

function addColumn(db: DB, table: string, column: string, decl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
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
