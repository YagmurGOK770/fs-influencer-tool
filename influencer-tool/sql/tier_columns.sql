-- Persisted outreach Tier (+ manual-override flag) on the 4 source tables.
-- The rule engine still computes a default tier; `tier_manual = true` marks a hand-picked override
-- that takes precedence and is never clobbered by re-running the rules / re-classifying.
--   tier        smallint  -- 1..4 = tier; NULL = no tier (filtered or not yet computed)
--   tier_manual boolean   -- true once a human set it on the UI
-- Run in the Supabase SQL editor before using the editable Tier feature. Idempotent.

do $$
declare t text;
begin
  foreach t in array array[
    'brightdata_profiles','brightdata_excluded_profiles',
    'lifestyle_bloggers','lifestyle_bloggers_excluded'
  ] loop
    execute format('alter table %I add column if not exists tier        smallint', t);
    execute format('alter table %I add column if not exists tier_manual boolean not null default false', t);
  end loop;
end $$;
