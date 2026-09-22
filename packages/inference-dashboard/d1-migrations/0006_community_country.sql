-- Where a community report came from, at country granularity.
--
-- nikcli-ai.dev/data could say what models installs run, but never where they
-- run. This adds the missing dimension for the geographic breakdown on that
-- page — and adds only that.
--
-- The value is the ISO 3166-1 alpha-2 code Cloudflare already attaches to the
-- request (`cf-ipcountry`). Nothing new is asked of the install, and no address
-- is stored: the edge resolves the country, the country is what gets written,
-- and the IP is discarded with the request. A country is not a location — it is
-- the coarsest geographic fact there is, and the only one the public page ever
-- publishes.
--
-- Nullable on purpose. Rows written before this migration have no country and
-- must stay countable in every other cut, so the feed groups NULL as "unknown"
-- rather than dropping it — a map that quietly discards its own history would
-- misstate the totals beside it.
ALTER TABLE community_stat ADD COLUMN country TEXT;

CREATE INDEX IF NOT EXISTS community_stat_country_idx ON community_stat(day, country);
