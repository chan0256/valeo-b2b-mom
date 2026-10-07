-- B2B Weekly MoM portal: Cloudflare D1 schema.
-- Paste this whole file into the D1 Console and press Execute. Safe to run again.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  title TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  pw_hash TEXT NOT NULL,
  pw_salt TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  weekday INTEGER NOT NULL DEFAULT 1,
  time TEXT NOT NULL DEFAULT '10:00',
  duration INTEGER NOT NULL DEFAULT 60,
  title TEXT NOT NULL DEFAULT 'UAE B2B Weekly Meeting',
  location TEXT NOT NULL DEFAULT ''
);
INSERT OR IGNORE INTO settings (id) VALUES (1);
CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  title TEXT NOT NULL,
  attendees TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  task TEXT NOT NULL,
  owner TEXT NOT NULL DEFAULT '',
  due TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','progress','done')),
  progress_note TEXT NOT NULL DEFAULT '',
  done_at TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);
CREATE INDEX IF NOT EXISTS items_meeting ON items(meeting_id);
CREATE TABLE IF NOT EXISTS item_assignees (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, user_id)
);
CREATE INDEX IF NOT EXISTS item_assignees_user ON item_assignees(user_id);
