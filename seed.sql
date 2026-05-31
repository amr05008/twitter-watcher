-- Initial watch_targets — edit this handle list before running to taste.
-- Run against --remote AFTER schema.sql:
--   wrangler d1 execute twitter-watcher --remote --file seed.sql
--
-- These are example AI/tech accounts. A good starting mix:
--   2-3 researchers, 2-3 lab voices, 1-2 indie builders, 1-2 ecosystem signal.
-- You can also add/remove handles at runtime via the API or MCP tools.
-- For an ongoing, hand-editable list, prefer watch-handles.txt + `npm run seed`
-- (syncs the file to D1) over re-running this one-shot bootstrap.

INSERT OR IGNORE INTO watch_targets (id, source, kind, handle, weight, added_at) VALUES
  ('twitter:handle:karpathy',     'twitter', 'handle', 'karpathy',     1.0, datetime('now')),
  ('twitter:handle:swyx',         'twitter', 'handle', 'swyx',         1.0, datetime('now')),
  ('twitter:handle:simonw',       'twitter', 'handle', 'simonw',       1.0, datetime('now')),
  ('twitter:handle:_xjdr',        'twitter', 'handle', '_xjdr',        1.0, datetime('now')),
  ('twitter:handle:natfriedman',  'twitter', 'handle', 'natfriedman',  1.0, datetime('now')),
  ('twitter:handle:sama',         'twitter', 'handle', 'sama',         1.0, datetime('now')),
  ('twitter:handle:AnthropicAI',  'twitter', 'handle', 'AnthropicAI',  1.0, datetime('now')),
  ('twitter:handle:OpenAIDevs',   'twitter', 'handle', 'OpenAIDevs',   1.0, datetime('now'));
