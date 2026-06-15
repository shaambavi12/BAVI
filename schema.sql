-- FlowState D1 schema
CREATE TABLE IF NOT EXISTS flows (
  id TEXT PRIMARY KEY,
  space TEXT NOT NULL,
  name TEXT,
  data TEXT NOT NULL,
  updated INTEGER
);
CREATE INDEX IF NOT EXISTS idx_flows_space ON flows(space, updated);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  space TEXT NOT NULL,
  ts INTEGER,
  device TEXT,
  flow TEXT,
  task_index INTEGER,
  task_label TEXT,
  allotted INTEGER,
  actual INTEGER,
  delta INTEGER,
  outcome TEXT,
  session TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_space ON events(space, ts);

CREATE TABLE IF NOT EXISTS commands (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  space TEXT NOT NULL,
  ts INTEGER,
  action TEXT,
  flow_id TEXT,
  start_at INTEGER,
  target TEXT,
  from_device TEXT
);
CREATE INDEX IF NOT EXISTS idx_commands_space ON commands(space, target, ts);
