-- One row per named attendance sheet (one class meeting).
CREATE TABLE sheets (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  secret      TEXT NOT NULL,           -- HMAC key for this sheet's rotating QR tokens
  status      TEXT NOT NULL DEFAULT 'closed' CHECK (status IN ('open', 'closed')),
  created_at  INTEGER NOT NULL,
  opened_at   INTEGER,
  closed_at   INTEGER
);

-- Single-use grace tickets issued when a student scans a fresh QR code.
CREATE TABLE tickets (
  id          TEXT PRIMARY KEY,
  sheet_id    TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  device_id   TEXT NOT NULL,
  issued_at   INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);
CREATE INDEX tickets_expires ON tickets(expires_at);

-- Check-ins.
CREATE TABLE records (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  sheet_id      TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  student_name  TEXT NOT NULL,
  student_id    TEXT NOT NULL,
  device_id     TEXT NOT NULL,
  ip            TEXT,
  flags         TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  UNIQUE (sheet_id, student_id)
);
CREATE INDEX records_sheet ON records(sheet_id, created_at);
