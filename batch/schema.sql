CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  closed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS responses (
  id TEXT PRIMARY KEY,
  batch TEXT NOT NULL,
  browser TEXT,
  name TEXT NOT NULL,
  company TEXT,
  department TEXT,
  role TEXT,
  answers TEXT NOT NULL,
  tally TEXT NOT NULL,
  summary TEXT NOT NULL,
  version TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_responses_batch ON responses(batch);
