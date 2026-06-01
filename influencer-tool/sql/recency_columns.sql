-- Recency / velocity inputs for the dynamic engagement score.
-- One set of per-day-averaged components (over the latest 5 posts) per creator, plus the newest
-- post date. Computed at enrichment by computeAggregates() and written to the source row.
-- Run in the Supabase SQL editor before re-enriching. Idempotent.

do $$
declare t text;
begin
  foreach t in array array[
    'brightdata_profiles','brightdata_excluded_profiles',
    'lifestyle_bloggers','lifestyle_bloggers_excluded'
  ] loop
    execute format('alter table %I add column if not exists recent_daily_likes    numeric', t);
    execute format('alter table %I add column if not exists recent_daily_comments numeric', t);
    execute format('alter table %I add column if not exists recent_daily_views    numeric', t);
    execute format('alter table %I add column if not exists recent_daily_saves    numeric', t);
    execute format('alter table %I add column if not exists recent_daily_shares   numeric', t);
    execute format('alter table %I add column if not exists last_post_at          timestamptz', t);
  end loop;
end $$;
