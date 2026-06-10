-- Custom per-influencer tags.
--
-- One row per person, keyed by handle (lowercased, no leading @) — mirrors influencer_outreach, so
-- a "person" is identified the same way across the app. `tags` is a JSONB array of free-text strings.
-- There is no separate tag-master table: the dropdown "vocabulary" the UI shows is just the distinct
-- union of every tag used across this table, so assigning a new tag to anyone makes it selectable for
-- everyone. Deleting all of a person's tags removes their row (keeps the table + vocabulary clean).
create table if not exists influencer_tags (
  handle      text primary key,
  tags        jsonb       not null default '[]'::jsonb,
  updated_at  timestamptz not null default now()
);

-- Fast membership/overlap filtering if we ever query by tag server-side (the UI currently filters
-- client-side, but this keeps a server-side `tags @> '["x"]'` cheap).
create index if not exists influencer_tags_tags_gin on influencer_tags using gin (tags);
