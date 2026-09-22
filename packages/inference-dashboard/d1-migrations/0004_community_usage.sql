-- Opt-in usage reports from nikcli installs.
--
-- `usage_events` only ever sees traffic that went through the inference
-- gateway. Most nikcli users bring their own provider keys, so their models
-- never appear there — which is the whole picture nikcli-ai.dev/data was
-- missing. This table holds what those installs choose to report: one row per
-- install, day, provider and model, and nothing else.
--
-- What is deliberately absent is the point: no prompt, no path, no repository,
-- no session title, no account, no IP. `install_id` is a random identifier the
-- CLI generates for itself; it exists so a resend replaces a day rather than
-- doubling it, and so unique installs per day can be counted. It is never
-- published — the public feed only ever emits COUNT(DISTINCT install_id).
CREATE TABLE IF NOT EXISTS community_usage (
  install_id TEXT    NOT NULL,
  day        TEXT    NOT NULL,            -- YYYY-MM-DD, UTC
  provider   TEXT    NOT NULL,
  model      TEXT    NOT NULL,
  messages   INTEGER NOT NULL DEFAULT 0,
  tokens     INTEGER NOT NULL DEFAULT 0,  -- input + output + reasoning + cache
  cost       REAL    NOT NULL DEFAULT 0,  -- USD, as the CLI priced it
  version    TEXT,                        -- nikcli version that reported
  updated_at INTEGER NOT NULL,
  -- A report for a day it has already sent overwrites that day, so a retry
  -- after a failed request cannot count the same tokens twice.
  PRIMARY KEY (install_id, day, provider, model)
);

CREATE INDEX IF NOT EXISTS community_usage_day_idx ON community_usage(day);
CREATE INDEX IF NOT EXISTS community_usage_model_idx ON community_usage(day, model);
