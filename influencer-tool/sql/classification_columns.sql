-- New structured-facts classification columns (replace the old influencer_type / tier / food_focus /
-- uk_based, which have been cleared). Populated by the new classifier (scripts/classify-batch.mjs);
-- the rule-based Tier is derived from these + engagement, computed separately.
-- Run in the Supabase SQL editor before running the classifier. Idempotent.

do $$
declare t text;
begin
  foreach t in array array['brightdata_profiles','lifestyle_bloggers'] loop
    execute format('alter table %I add column if not exists entity_type               text',    t);
    execute format('alter table %I add column if not exists primary_content_category   text',    t);
    execute format('alter table %I add column if not exists primary_food_content_type  text',    t);
    execute format('alter table %I add column if not exists food_post_count            integer', t);
    execute format('alter table %I add column if not exists total_posts_analyzed       integer', t);
    execute format('alter table %I add column if not exists uk_geography               text',    t);
    execute format('alter table %I add column if not exists classification_reasoning   text',    t);
  end loop;
end $$;
