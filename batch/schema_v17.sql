-- v17: personal links tied to staff ID. Run once in the D1 console (each statement separately if asked).
CREATE TABLE IF NOT EXISTS staff (
  staff_id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  department TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '',
  directorship INTEGER NOT NULL DEFAULT 0,
  cohort TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
ALTER TABLE responses ADD COLUMN staff_id TEXT;
ALTER TABLE responses ADD COLUMN survey_version TEXT;
ALTER TABLE responses ADD COLUMN lark_status TEXT;
ALTER TABLE responses ADD COLUMN lark_note TEXT;
CREATE INDEX IF NOT EXISTS idx_responses_staff ON responses(staff_id);
