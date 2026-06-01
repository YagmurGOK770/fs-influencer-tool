-- profile_posts: one row per recent post/video per influencer.
-- Run this in the Supabase SQL editor before running scripts/enrich-posts-batch.mjs.
-- Idempotent: safe to re-run.

create table if not exists profile_posts (
  id            bigint generated always as identity primary key,
  handle        text        not null,
  platform      text        not null,            -- instagram | tiktok | x | youtube
  post_id       text        not null,            -- shortcode / video id / tweet id
  post_url      text,
  type          text,                            -- image | video | carousel | reel | slideshow | tweet
  caption       text,
  hashtags      jsonb,
  mentions      jsonb,
  likes         bigint,
  comments      bigint,
  views         bigint,
  saves         bigint,                          -- null for instagram/youtube
  shares        bigint,                          -- null for instagram/youtube
  posted_at     timestamptz,
  location      text,
  tagged_users  jsonb,
  music         text,                            -- tiktok
  duration_sec  integer,                         -- video/tiktok/youtube
  thumbnail_url text,
  media_urls    jsonb,
  raw           jsonb,                            -- full source payload, future-proofing
  fetched_at    timestamptz default now(),
  unique (handle, platform, post_id)
);

create index if not exists profile_posts_handle_platform_idx
  on profile_posts (handle, platform);
create index if not exists profile_posts_posted_at_idx
  on profile_posts (posted_at desc);

-- Profile-level aggregate columns used by the enrichment recompute step.
-- avg_likes / avg_comments already exist; add the rest if missing.
alter table brightdata_profiles          add column if not exists avg_views  bigint;
alter table brightdata_profiles          add column if not exists avg_saves  bigint;
alter table brightdata_profiles          add column if not exists avg_shares bigint;
alter table brightdata_excluded_profiles add column if not exists avg_views  bigint;
alter table brightdata_excluded_profiles add column if not exists avg_saves  bigint;
alter table brightdata_excluded_profiles add column if not exists avg_shares bigint;
alter table lifestyle_bloggers           add column if not exists avg_views  bigint;
alter table lifestyle_bloggers           add column if not exists avg_saves  bigint;
alter table lifestyle_bloggers           add column if not exists avg_shares bigint;
alter table lifestyle_bloggers_excluded  add column if not exists avg_views  bigint;
alter table lifestyle_bloggers_excluded  add column if not exists avg_saves  bigint;
alter table lifestyle_bloggers_excluded  add column if not exists avg_shares bigint;
