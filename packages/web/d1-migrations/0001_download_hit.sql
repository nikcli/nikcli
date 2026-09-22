-- Where downloads come from, at country granularity.
--
-- GitHub and npm both publish a download counter and nothing else: a release
-- asset carries `download_count`, an integer, and npm's API returns totals per
-- day. Neither exposes geography in any form, to anyone, so the map on
-- nikcli-ai.dev/data cannot be derived from them — the dimension does not exist
-- upstream.
--
-- It exists here instead. `install` and `install.ps1` already fetch from
-- nikcli-ai.dev/releases/download/<tag>/<asset> as their primary URL, so the
-- request passes our edge before it reaches GitHub. That request carries
-- `cf-ipcountry`, which is the country, resolved by Cloudflare, without asking
-- the client for anything. The route records it and redirects; the file is
-- still served by GitHub and GitHub's own counter still increments, so the
-- totals stay reconcilable against STATS.md.
--
-- What is deliberately absent, as everywhere else behind /data: no address, no
-- user agent, no identifier of any kind. A day, a country and an asset name is
-- the whole row. Nothing here can be traced to a person, and nothing here is a
-- location — a country is the coarsest geographic fact there is.
--
-- This counts from the day it ships. Downloads already in STATS.md have no
-- country and never will, so the page shows this as its own measurement rather
-- than back-filling a history it cannot know.
CREATE TABLE IF NOT EXISTS download_hit (
  day     TEXT    NOT NULL,            -- YYYY-MM-DD, UTC
  country TEXT    NOT NULL,            -- ISO 3166-1 alpha-2, or 'XX' when the edge had none
  asset   TEXT    NOT NULL,            -- release asset filename, as requested
  hits    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, country, asset)
);

CREATE INDEX IF NOT EXISTS download_hit_day_idx     ON download_hit(day);
CREATE INDEX IF NOT EXISTS download_hit_country_idx ON download_hit(country);
