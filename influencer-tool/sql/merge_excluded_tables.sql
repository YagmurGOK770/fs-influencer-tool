-- Merge the two "excluded" tables into their main tables, then retire the excluded tables.
-- The rule-based Tier system (tier 1..4 = in scope, status 'filtered' = out of scope) now does
-- the filtering, so a separate excluded table is no longer needed. NOTHING is discarded.
--
--   brightdata_excluded_profiles -> brightdata_profiles
--   lifestyle_bloggers_excluded  -> lifestyle_bloggers
--
-- The `id` column is GENERATED ALWAYS AS IDENTITY, so we CANNOT copy it (and OVERRIDING SYSTEM
-- VALUE would collide — both tables' id sequences start at 1). Instead we insert an explicit
-- column list built dynamically from the columns COMMON to both tables minus `id`, letting the
-- main table assign fresh ids. This is also resilient to any schema drift between the pair.
--
-- Conflict policy for a (handle, platform) present in BOTH tables: keep the surviving row and
-- backfill any gaps from the excluded copy via coalesce() (so no bio/captions/classification
-- signal is lost), and bump fetched_at to the newer of the two. This is preferred over a plain
-- INSERT ... ON CONFLICT DO NOTHING (drops excluded signal) or DO UPDATE (could null out main signal).
--
-- SAFETY: this RENAMEs the excluded tables to *_retired rather than dropping them, so the merge is
-- reversible. Drop the *_retired tables manually only after the new single-table UI is verified.
--
-- Run ONCE in the Supabase SQL editor. Idempotent: after the rename, to_regclass() returns NULL for
-- the original names so re-running is a no-op. Take a Supabase snapshot before running.

-- ── FOOD: brightdata_excluded_profiles -> brightdata_profiles ──────────────────────────
do $$
declare cols text; ecols text;
begin
  if to_regclass('public.brightdata_excluded_profiles') is not null then
    -- Column list common to both tables, excluding the identity `id`. `cols` is the bare
    -- list for the INSERT target; `ecols` is the same prefixed with e. for the SELECT.
    select string_agg(quote_ident(c.column_name), ', '),
           string_agg('e.' || quote_ident(c.column_name), ', ')
      into cols, ecols
      from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = 'brightdata_profiles'
       and c.column_name <> 'id'
       and exists (
         select 1 from information_schema.columns x
          where x.table_schema = 'public' and x.table_name = 'brightdata_excluded_profiles'
            and x.column_name = c.column_name
       );

    -- 1) Insert excluded-only rows (identity not already in main); id is generated fresh.
    execute format(
      'insert into brightdata_profiles (%1$s)
         select %2$s from brightdata_excluded_profiles e
         where not exists (
           select 1 from brightdata_profiles m
           where m.handle = e.handle and m.platform = e.platform
         )', cols, ecols);

    -- 2) For rows in BOTH: backfill gaps from the excluded copy, never overwriting populated
    --    main data, and keep the newest fetched_at. Preserve a manual tier flag from either side.
    update brightdata_profiles m set
      fetched_at                 = greatest(m.fetched_at, e.fetched_at),
      bio                        = coalesce(m.bio, e.bio),
      post_captions              = coalesce(m.post_captions, e.post_captions),
      post_locations             = coalesce(m.post_locations, e.post_locations),
      matched_keywords           = coalesce(m.matched_keywords, e.matched_keywords),
      language                   = coalesce(m.language, e.language),
      entity_type                = coalesce(m.entity_type, e.entity_type),
      primary_content_category   = coalesce(m.primary_content_category, e.primary_content_category),
      primary_food_content_type  = coalesce(m.primary_food_content_type, e.primary_food_content_type),
      food_post_count            = coalesce(m.food_post_count, e.food_post_count),
      total_posts_analyzed       = coalesce(m.total_posts_analyzed, e.total_posts_analyzed),
      uk_geography               = coalesce(m.uk_geography, e.uk_geography),
      classification_reasoning   = coalesce(m.classification_reasoning, e.classification_reasoning),
      tier                       = coalesce(m.tier, e.tier),
      tier_manual                = (m.tier_manual or e.tier_manual)
    from brightdata_excluded_profiles e
    where m.handle = e.handle and m.platform = e.platform;

    -- 3) Retire the excluded table (reversible — drop *_retired later once verified).
    if to_regclass('public.brightdata_excluded_profiles_retired') is null then
      alter table brightdata_excluded_profiles rename to brightdata_excluded_profiles_retired;
    end if;
  end if;
end $$;

-- ── LIFESTYLE: lifestyle_bloggers_excluded -> lifestyle_bloggers ───────────────────────
do $$
declare cols text; ecols text;
begin
  if to_regclass('public.lifestyle_bloggers_excluded') is not null then
    select string_agg(quote_ident(c.column_name), ', '),
           string_agg('e.' || quote_ident(c.column_name), ', ')
      into cols, ecols
      from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = 'lifestyle_bloggers'
       and c.column_name <> 'id'
       and exists (
         select 1 from information_schema.columns x
          where x.table_schema = 'public' and x.table_name = 'lifestyle_bloggers_excluded'
            and x.column_name = c.column_name
       );

    execute format(
      'insert into lifestyle_bloggers (%1$s)
         select %2$s from lifestyle_bloggers_excluded e
         where not exists (
           select 1 from lifestyle_bloggers m
           where m.handle = e.handle and m.platform = e.platform
         )', cols, ecols);

    update lifestyle_bloggers m set
      fetched_at                 = greatest(m.fetched_at, e.fetched_at),
      bio                        = coalesce(m.bio, e.bio),
      post_captions              = coalesce(m.post_captions, e.post_captions),
      post_locations             = coalesce(m.post_locations, e.post_locations),
      matched_keywords           = coalesce(m.matched_keywords, e.matched_keywords),
      language                   = coalesce(m.language, e.language),
      entity_type                = coalesce(m.entity_type, e.entity_type),
      primary_content_category   = coalesce(m.primary_content_category, e.primary_content_category),
      primary_food_content_type  = coalesce(m.primary_food_content_type, e.primary_food_content_type),
      food_post_count            = coalesce(m.food_post_count, e.food_post_count),
      total_posts_analyzed       = coalesce(m.total_posts_analyzed, e.total_posts_analyzed),
      uk_geography               = coalesce(m.uk_geography, e.uk_geography),
      classification_reasoning   = coalesce(m.classification_reasoning, e.classification_reasoning),
      tier                       = coalesce(m.tier, e.tier),
      tier_manual                = (m.tier_manual or e.tier_manual)
    from lifestyle_bloggers_excluded e
    where m.handle = e.handle and m.platform = e.platform;

    if to_regclass('public.lifestyle_bloggers_excluded_retired') is null then
      alter table lifestyle_bloggers_excluded rename to lifestyle_bloggers_excluded_retired;
    end if;
  end if;
end $$;

-- After verifying the new UI, drop the retired tables:
--   drop table if exists brightdata_excluded_profiles_retired;
--   drop table if exists lifestyle_bloggers_excluded_retired;
