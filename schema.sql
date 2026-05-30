-- Twitter Watcher D1 schema
-- Run against --remote BEFORE first deploy:
--   wrangler d1 execute twitter-watcher --remote --file schema.sql

CREATE TABLE IF NOT EXISTS watch_targets (
  id            TEXT PRIMARY KEY,                       -- 'twitter:handle:karpathy' or 'twitter:search:ai-agents'
  source        TEXT NOT NULL,                          -- 'twitter'
  kind          TEXT NOT NULL DEFAULT 'handle',         -- 'handle' | 'search'
  handle        TEXT NOT NULL,                          -- handle for kind='handle'; query string for kind='search'
  weight        REAL DEFAULT 1.0,                       -- reserved; not consumed by today's prompt
  added_at      TEXT NOT NULL,
  UNIQUE(source, kind, handle)
);

CREATE TABLE IF NOT EXISTS posts (
  id              TEXT PRIMARY KEY,                     -- '<source>:<sourceId>' — globally unique
  source          TEXT NOT NULL,
  source_id       TEXT NOT NULL,
  target_id       TEXT NOT NULL REFERENCES watch_targets(id),
  author          TEXT NOT NULL,
  posted_at       TEXT NOT NULL,
  text            TEXT NOT NULL,
  url             TEXT NOT NULL,
  raw             TEXT NOT NULL,                        -- original JSON payload
  summarized_in   TEXT,                                 -- briefing id, NULL until included
  UNIQUE(source, source_id)
);

CREATE INDEX IF NOT EXISTS idx_posts_unsummarized
  ON posts(summarized_in, posted_at)
  WHERE summarized_in IS NULL;

CREATE TABLE IF NOT EXISTS briefings (
  id            TEXT PRIMARY KEY,                       -- 'YYYY-MM-DD' for cron; ULID for manual
  generated_at  TEXT NOT NULL,
  post_count    INTEGER NOT NULL,
  output        TEXT NOT NULL,
  trigger       TEXT NOT NULL                           -- 'cron' | 'manual'
);
