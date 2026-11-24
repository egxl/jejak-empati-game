CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  xp INTEGER NOT NULL DEFAULT 0,
  day INTEGER NOT NULL DEFAULT 1,
  done INTEGER NOT NULL DEFAULT 0,
  rank TEXT NOT NULL DEFAULT '',
  calmed INTEGER NOT NULL DEFAULT 0,
  riots INTEGER NOT NULL DEFAULT 0,
  ts INTEGER NOT NULL,
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_runs_leaderboard ON runs (score DESC, xp DESC, updated_at DESC);

CREATE TABLE checkins (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  nama TEXT NOT NULL,
  sudah_mencoba TEXT NOT NULL DEFAULT '',
  perasaan TEXT NOT NULL DEFAULT '',
  tersulit TEXT NOT NULL DEFAULT '',
  pertanyaan_refleksi TEXT NOT NULL DEFAULT '',
  refleksi TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_checkins_created_at ON checkins (created_at DESC);
