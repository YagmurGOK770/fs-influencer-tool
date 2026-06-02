-- Inputs for the dynamic, cross-platform engagement score (computed at enrichment by
-- computeAggregates() and written to the source row). Run in the Supabase SQL editor before
-- re-enriching. Idempotent.
--   median_*       : median of each metric over the posts fetched (robust to one viral/dead post)
--   recent_daily_* : per-day engagement over the latest <=5 posts (velocity / recency signal)
--   posts_sampled  : how many posts the score is actually based on (<=30)
--   last_post_at   : newest post date (also useful for "active recently")

do $$
declare t text;
begin
  foreach t in array array['brightdata_profiles','lifestyle_bloggers'] loop
    execute format('alter table %I add column if not exists median_likes    numeric', t);
    execute format('alter table %I add column if not exists median_comments numeric', t);
    execute format('alter table %I add column if not exists median_views    numeric', t);
    execute format('alter table %I add column if not exists median_saves    numeric', t);
    execute format('alter table %I add column if not exists median_shares   numeric', t);
    execute format('alter table %I add column if not exists posts_sampled   integer', t);
    execute format('alter table %I add column if not exists recent_daily_likes    numeric', t);
    execute format('alter table %I add column if not exists recent_daily_comments numeric', t);
    execute format('alter table %I add column if not exists recent_daily_views    numeric', t);
    execute format('alter table %I add column if not exists recent_daily_saves    numeric', t);
    execute format('alter table %I add column if not exists recent_daily_shares   numeric', t);
    execute format('alter table %I add column if not exists last_post_at          timestamptz', t);
  end loop;
end $$;
