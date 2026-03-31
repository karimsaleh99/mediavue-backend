-- supabase-schema.sql
-- Run this in your Supabase project: Dashboard → SQL Editor → New query → paste → Run
-- Creates the two tables MédiaVue needs: stories and articles

-- ── Stories table ────────────────────────────────────────────────────────────
-- One row per clustered story (the "card" users see in the feed)

create table if not exists stories (
  id              uuid primary key default gen_random_uuid(),
  title           text not null,
  summary         text,
  category        text,
  published_at    timestamptz not null,
  coverage_count  integer default 1,
  source_ids      text[] default '{}',

  -- JSON: { "gauche": 2, "centre": 1, "droite": 1 }
  coverage_by_orientation jsonb default '{}',

  -- JSON: { "sides": ["droite"], "label": "Peu couvert par : droite" } or null
  blindspot       jsonb,

  created_at      timestamptz default now(),
  updated_at      timestamptz default now(),

  -- Prevents duplicate stories on upsert
  unique(title)
);

-- Index for fast feed queries (sorted by coverage then date)
create index if not exists stories_coverage_idx
  on stories (coverage_count desc, published_at desc);

create index if not exists stories_category_idx
  on stories (category);

-- ── Articles table ───────────────────────────────────────────────────────────
-- One row per individual article, linked to its parent story

create table if not exists articles (
  id                uuid primary key default gen_random_uuid(),
  story_id          uuid references stories(id) on delete cascade,
  source_id         text not null,
  title             text not null,
  summary           text,
  url               text not null unique,   -- prevents duplicate articles
  image_url         text,
  published_at      timestamptz not null,
  orientation       text,
  orientation_score integer,
  created_at        timestamptz default now()
);

create index if not exists articles_story_idx on articles (story_id);
create index if not exists articles_source_idx on articles (source_id);

-- ── Row Level Security ───────────────────────────────────────────────────────
-- Public read access (anyone can read stories/articles)
-- Write access only via service role key (your backend)

alter table stories enable row level security;
alter table articles enable row level security;

create policy "Public read access on stories"
  on stories for select using (true);

create policy "Public read access on articles"
  on articles for select using (true);

create policy "Service role can write stories"
  on stories for all using (auth.role() = 'service_role');

create policy "Service role can write articles"
  on articles for all using (auth.role() = 'service_role');
