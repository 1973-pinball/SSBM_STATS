-- Public tournament replay archive schema.
--
-- Run after schema.sql. This dataset is deliberately separate from the private,
-- per-user game_record_packs tables and the opt-in community contribution tables.
-- It contains only derived replay metadata, per-player statistics, and rollups.
-- Raw .slp bytes, local paths/file names, private user ids, and unresolved connect
-- codes must never be inserted here.
--
-- The browser has read-only access to rows explicitly marked `published`. Imports
-- use the Supabase service role, stage rows with published=false, validate them,
-- and publish the completed dataset in one transaction. Re-running this file is
-- safe: tables and indexes are created idempotently and policies are replaced.

begin;

create table if not exists public.archive_datasets (
  id text primary key,
  label text not null,
  source_url text not null,
  source_label text not null,
  license_url text,
  compressed_bytes bigint not null check (compressed_bytes >= 0),
  archive_count integer not null check (archive_count >= 0),
  replay_file_count integer not null check (replay_file_count >= 0),
  parsed_replay_count integer not null check (parsed_replay_count >= 0),
  unique_game_count integer not null check (unique_game_count >= 0),
  broad_game_count integer not null check (broad_game_count >= 0),
  conservative_game_count integer not null check (conservative_game_count >= 0),
  parser_version text not null,
  curation_version text not null,
  data_as_of date not null,
  import_counts jsonb not null default '{}'::jsonb check (jsonb_typeof(import_counts) = 'object'),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  notes text,
  published boolean not null default false,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (not published or published_at is not null),
  check (parsed_replay_count <= replay_file_count),
  check (broad_game_count <= unique_game_count),
  check (conservative_game_count <= broad_game_count)
);

-- Stable series identity makes cross-edition questions explicit: all Riptides,
-- all GENESIS events, all Battle of BC events, and so on. One-off events still
-- receive a series row so the UI never has to infer families from display names.
create table if not exists public.archive_tournament_series (
  id text primary key,
  canonical_name text not null,
  source_url text,
  notes text,
  published boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per downloaded archive. This is provenance and volume accounting only;
-- source object names and local extraction paths are intentionally not retained.
create table if not exists public.archive_bundles (
  id text primary key,
  dataset_id text not null references public.archive_datasets (id) on delete cascade,
  tournament_id text,
  public_source_url text not null,
  compressed_bytes bigint not null check (compressed_bytes >= 0),
  replay_file_count integer not null check (replay_file_count >= 0),
  parsed_replay_count integer not null check (parsed_replay_count >= 0),
  failed_replay_count integer not null check (failed_replay_count >= 0),
  duplicate_replay_count integer not null check (duplicate_replay_count >= 0),
  published boolean not null default false,
  created_at timestamptz not null default now(),
  check (parsed_replay_count + failed_replay_count = replay_file_count),
  check (duplicate_replay_count <= parsed_replay_count)
);

-- Tournament year/date comes from a cited event source, not the replay clock.
-- `is_tournament=false` keeps known non-event material auditable without allowing
-- it into either benchmark population.
create table if not exists public.archive_tournaments (
  id text primary key,
  dataset_id text not null references public.archive_datasets (id) on delete cascade,
  event_key text not null,
  series_id text references public.archive_tournament_series (id) on delete restrict,
  canonical_name text not null,
  year smallint check (year between 2001 and 2100),
  start_date date,
  end_date date,
  location text,
  online boolean,
  is_tournament boolean not null default true,
  event_source_url text,
  event_source_label text,
  source_confidence text not null default 'unverified'
    check (source_confidence in ('verified', 'probable', 'unverified')),
  notes text,
  published boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date is null or start_date is null or end_date >= start_date),
  check (
    (not is_tournament)
    or (source_confidence = 'unverified')
    or (year is not null and event_source_url is not null)
  )
);

alter table public.archive_datasets add column if not exists import_counts jsonb not null default '{}'::jsonb;
alter table public.archive_datasets
  drop constraint if exists archive_datasets_import_counts_check;
alter table public.archive_datasets
  add constraint archive_datasets_import_counts_check check (jsonb_typeof(import_counts) = 'object');
alter table public.archive_datasets add column if not exists content_sha256 text;
alter table public.archive_datasets
  drop constraint if exists archive_datasets_content_sha256_check;
alter table public.archive_datasets
  add constraint archive_datasets_content_sha256_check
  check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$');

alter table public.archive_tournaments add column if not exists event_key text;
update public.archive_tournaments set event_key = id where event_key is null;
alter table public.archive_tournaments alter column event_key set not null;

-- Replace the earlier unnamed checks with stable constraints so this migration
-- is safe over draft installations as well as a fresh database.
alter table public.archive_tournaments
  drop constraint if exists archive_tournaments_check;
alter table public.archive_tournaments
  drop constraint if exists archive_tournaments_check1;
alter table public.archive_tournaments
  drop constraint if exists archive_tournaments_date_order_check;
alter table public.archive_tournaments
  drop constraint if exists archive_tournaments_source_check;
alter table public.archive_tournaments
  add constraint archive_tournaments_date_order_check
    check (end_date is null or start_date is null or end_date >= start_date);
alter table public.archive_tournaments
  add constraint archive_tournaments_source_check check (
    (not is_tournament)
    or (source_confidence = 'unverified')
    or (year is not null and event_source_url is not null)
  );

-- Forward-compatible when this file is re-run over an earlier archive schema.
alter table public.archive_tournaments add column if not exists series_id text;
alter table public.archive_tournaments
  drop constraint if exists archive_tournaments_series_id_fkey;
alter table public.archive_tournaments
  add constraint archive_tournaments_series_id_fkey
  foreign key (series_id) references public.archive_tournament_series (id) on delete restrict;

alter table public.archive_bundles
  drop constraint if exists archive_bundles_tournament_id_fkey;
alter table public.archive_bundles
  add constraint archive_bundles_tournament_id_fkey
  foreign key (tournament_id) references public.archive_tournaments (id) on delete set null;

-- Only public, resolved identities belong here. Anonymous replay slots use a null
-- player_id in archive_game_players; private or ambiguous connect codes are never
-- promoted to a public player merely to improve identity coverage.
create table if not exists public.archive_players (
  id text primary key,
  display_name text not null,
  normalized_name text not null,
  liquipedia_url text,
  country_code text check (country_code is null or country_code ~ '^[A-Z]{2}$'),
  active boolean,
  notes text,
  published boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists archive_players_normalized_name_idx
  on public.archive_players (normalized_name);

-- Aliases are limited to already-public tags/names. Connect codes are explicitly
-- excluded so this table cannot become a directory of unrelated archive players.
create table if not exists public.archive_player_aliases (
  player_id text not null references public.archive_players (id) on delete cascade,
  alias text not null,
  normalized_alias text not null,
  alias_kind text not null
    check (alias_kind in ('bracket_tag', 'broadcast_tag', 'liquipedia_name')),
  source_url text,
  confidence text not null default 'verified'
    check (confidence in ('verified', 'probable')),
  published boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (player_id, normalized_alias)
);

create index if not exists archive_player_aliases_lookup_idx
  on public.archive_player_aliases (normalized_alias);

-- A player is eligible for the compact ranked-player picker when they have a
-- public ranking row. Keeping editions normalized lets the list update when a
-- new ranking snapshot is imported instead of hard-coding a fixed roster.
create table if not exists public.archive_player_rankings (
  player_id text not null references public.archive_players (id) on delete cascade,
  ranking_series text not null,
  edition_label text not null,
  edition_year smallint not null check (edition_year between 2001 and 2100),
  rank smallint not null check (rank between 1 and 100),
  source_url text not null,
  published boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (player_id, ranking_series, edition_label)
);

create index if not exists archive_player_rankings_picker_idx
  on public.archive_player_rankings (edition_year desc, rank, player_id);

-- A set may be bracket-verified, inferred from a plausible consecutive sequence,
-- or unresolved. Unresolved games remain useful for broad Community aggregates
-- but do not appear as named sets in the Tournament explorer.
create table if not exists public.archive_sets (
  id text primary key,
  tournament_id text not null references public.archive_tournaments (id) on delete cascade,
  format text not null check (format in ('singles', 'doubles')),
  round_label text,
  best_of smallint check (best_of in (3, 5, 7)),
  set_order integer check (set_order is null or set_order >= 0),
  resolution text not null
    check (resolution in ('verified', 'probable')),
  resolution_source_url text,
  completed boolean not null default true,
  published boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists archive_sets_tournament_idx
  on public.archive_sets (tournament_id, set_order, id);

create index if not exists archive_tournaments_series_idx
  on public.archive_tournaments (series_id, year, id)
  where series_id is not null;
create unique index if not exists archive_tournaments_dataset_event_idx
  on public.archive_tournaments (dataset_id, event_key);

create table if not exists public.archive_set_players (
  set_id text not null references public.archive_sets (id) on delete cascade,
  slot smallint not null check (slot between 0 and 3),
  team_id smallint,
  player_id text references public.archive_players (id) on delete set null,
  display_name text,
  winner boolean,
  published boolean not null default false,
  primary key (set_id, slot),
  check (player_id is not null or display_name is not null)
);

create index if not exists archive_set_players_player_idx
  on public.archive_set_players (player_id, set_id)
  where player_id is not null;

-- Content-derived game identity plus derived metadata only. `played_at` is used
-- for ordering within an event; event dates and years always come from the cited
-- tournament row because replay clocks are not authoritative.
create table if not exists public.archive_games (
  game_key text primary key,
  dataset_id text not null references public.archive_datasets (id) on delete cascade,
  tournament_id text not null references public.archive_tournaments (id) on delete cascade,
  set_id text references public.archive_sets (id) on delete set null,
  sequence_in_set smallint check (sequence_in_set is null or sequence_in_set >= 1),
  played_at timestamptz,
  stage_id smallint not null,
  duration_frames integer not null check (duration_frames >= 1800),
  format text not null check (format in ('singles', 'doubles')),
  winner_slot smallint check (winner_slot between 0 and 3),
  winner_team_id smallint,
  curation_tier text not null
    check (curation_tier in ('verified', 'probable', 'unclassified')),
  stats_version integer not null check (stats_version >= 1),
  published boolean not null default false,
  created_at timestamptz not null default now(),
  check ((format = 'singles' and winner_team_id is null) or format = 'doubles')
);

create index if not exists archive_games_tournament_filter_idx
  on public.archive_games (tournament_id, curation_tier, format, stage_id);
create index if not exists archive_games_set_idx
  on public.archive_games (set_id, sequence_in_set)
  where set_id is not null;

-- One small derived-stat row per player side. `move_stats` is intentionally JSONB:
-- keeping the ~20 sparse move entries together avoids millions of narrow rows,
-- while archive_rollups serves normal dashboard queries without scanning these.
create table if not exists public.archive_game_players (
  game_key text not null references public.archive_games (game_key) on delete cascade,
  slot smallint not null check (slot between 0 and 3),
  team_id smallint,
  player_id text references public.archive_players (id) on delete set null,
  identity_resolution text
    check (identity_resolution is null or identity_resolution in ('verified', 'probable')),
  identity_source_url text,
  character_id smallint not null,
  won boolean,
  stocks_taken smallint check (stocks_taken is null or stocks_taken >= 0),
  damage_total numeric(9,2) check (damage_total is null or damage_total >= 0),
  neutral_wins integer check (neutral_wins is null or neutral_wins >= 0),
  openings_per_kill numeric(8,3) check (openings_per_kill is null or openings_per_kill >= 0),
  damage_per_opening numeric(8,3) check (damage_per_opening is null or damage_per_opening >= 0),
  inputs_per_minute numeric(9,3) check (inputs_per_minute is null or inputs_per_minute >= 0),
  l_cancel_success integer not null default 0 check (l_cancel_success >= 0),
  l_cancel_fail integer not null default 0 check (l_cancel_fail >= 0),
  tech_in_place integer not null default 0 check (tech_in_place >= 0),
  tech_toward integer not null default 0 check (tech_toward >= 0),
  tech_away integer not null default 0 check (tech_away >= 0),
  tech_missed integer not null default 0 check (tech_missed >= 0),
  wall_tech_success integer not null default 0 check (wall_tech_success >= 0),
  wall_tech_missed integer not null default 0 check (wall_tech_missed >= 0),
  action_counts jsonb not null default '{}'::jsonb check (jsonb_typeof(action_counts) = 'object'),
  move_stats jsonb not null default '{}'::jsonb check (jsonb_typeof(move_stats) = 'object'),
  published boolean not null default false,
  primary key (game_key, slot),
  check (
    (player_id is null and identity_resolution is null and identity_source_url is null)
    or (player_id is not null and identity_resolution is not null)
  )
);

-- Forward-compatible when this file is re-run over an earlier archive schema.
alter table public.archive_game_players add column if not exists identity_resolution text;
alter table public.archive_game_players add column if not exists identity_source_url text;
alter table public.archive_game_players add column if not exists wall_tech_success integer not null default 0;
alter table public.archive_game_players add column if not exists wall_tech_missed integer not null default 0;
alter table public.archive_game_players add column if not exists action_counts jsonb not null default '{}'::jsonb;
alter table public.archive_game_players
  drop constraint if exists archive_game_players_action_counts_check;
alter table public.archive_game_players
  add constraint archive_game_players_action_counts_check
  check (jsonb_typeof(action_counts) = 'object');
alter table public.archive_game_players
  drop constraint if exists archive_game_players_wall_tech_check;
alter table public.archive_game_players
  add constraint archive_game_players_wall_tech_check
  check (wall_tech_success >= 0 and wall_tech_missed >= 0);
alter table public.archive_game_players
  drop constraint if exists archive_game_players_identity_resolution_check;
alter table public.archive_game_players
  add constraint archive_game_players_identity_resolution_check
  check (identity_resolution is null or identity_resolution in ('verified', 'probable'));
alter table public.archive_game_players
  drop constraint if exists archive_game_players_identity_check;
alter table public.archive_game_players
  add constraint archive_game_players_identity_check
  check (
    (player_id is null and identity_resolution is null and identity_source_url is null)
    or (player_id is not null and identity_resolution is not null)
  );

create index if not exists archive_game_players_player_idx
  on public.archive_game_players (player_id, character_id, game_key)
  where player_id is not null;
create index if not exists archive_game_players_character_idx
  on public.archive_game_players (character_id, game_key);

-- Query-ready aggregates for both product surfaces. `population=broad` powers
-- Community/Venue comparisons; `population=conservative` powers bracket-oriented
-- Tournament comparisons. Null dimensions mean "all". Named-player and set rows
-- may coexist with tournament/global rows under deterministic rollup_key values.
create table if not exists public.archive_rollups (
  rollup_key text primary key,
  dataset_id text not null references public.archive_datasets (id) on delete cascade,
  scope text not null check (scope in ('community', 'series', 'tournament', 'player', 'set')),
  population text not null check (population in ('broad', 'conservative')),
  series_id text references public.archive_tournament_series (id) on delete cascade,
  tournament_id text references public.archive_tournaments (id) on delete cascade,
  set_id text references public.archive_sets (id) on delete cascade,
  player_id text references public.archive_players (id) on delete cascade,
  format text check (format in ('singles', 'doubles')),
  character_id smallint,
  opponent_character_id smallint,
  stage_id smallint,
  game_count integer not null check (game_count >= 0),
  win_rate_game_count integer not null default 0 check (win_rate_game_count >= 0),
  wins integer not null default 0 check (wins >= 0),
  identified_player_count integer check (identified_player_count is null or identified_player_count >= 0),
  player_balanced_sample_count integer check (player_balanced_sample_count is null or player_balanced_sample_count >= 0),
  metrics jsonb not null check (jsonb_typeof(metrics) = 'object'),
  stats_version integer not null check (stats_version >= 1),
  published boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (wins <= win_rate_game_count),
  check (
    (scope = 'community' and series_id is null and tournament_id is null and set_id is null and player_id is null)
    or (scope = 'series' and series_id is not null and tournament_id is null and set_id is null and player_id is null)
    or (scope = 'tournament' and tournament_id is not null and set_id is null and player_id is null)
    or (scope = 'player' and player_id is not null and set_id is null)
    or (scope = 'set' and set_id is not null)
  )
);

alter table public.archive_rollups add column if not exists series_id text;
alter table public.archive_rollups
  drop constraint if exists archive_rollups_series_id_fkey;
alter table public.archive_rollups
  add constraint archive_rollups_series_id_fkey
  foreign key (series_id) references public.archive_tournament_series (id) on delete cascade;
alter table public.archive_rollups
  drop constraint if exists archive_rollups_scope_check;
alter table public.archive_rollups
  add constraint archive_rollups_scope_check
  check (scope in ('community', 'series', 'tournament', 'player', 'set'));
alter table public.archive_rollups
  drop constraint if exists archive_rollups_check;
alter table public.archive_rollups
  drop constraint if exists archive_rollups_check1;
alter table public.archive_rollups
  drop constraint if exists archive_rollups_counts_check;
alter table public.archive_rollups
  drop constraint if exists archive_rollups_scope_shape_check;
alter table public.archive_rollups
  add constraint archive_rollups_counts_check
  check (wins <= win_rate_game_count);
alter table public.archive_rollups
  add constraint archive_rollups_scope_shape_check
  check (
    (scope = 'community' and series_id is null and tournament_id is null and set_id is null and player_id is null)
    or (scope = 'series' and series_id is not null and tournament_id is null and set_id is null and player_id is null)
    or (scope = 'tournament' and tournament_id is not null and set_id is null and player_id is null)
    or (scope = 'player' and player_id is not null and set_id is null)
    or (scope = 'set' and set_id is not null)
  );

create index if not exists archive_rollups_filter_idx
  on public.archive_rollups
    (scope, population, series_id, character_id, opponent_character_id, stage_id, format);
create index if not exists archive_rollups_series_idx
  on public.archive_rollups (series_id, player_id, population)
  where series_id is not null;
create index if not exists archive_rollups_tournament_idx
  on public.archive_rollups (tournament_id, player_id, population)
  where tournament_id is not null;
create index if not exists archive_rollups_player_idx
  on public.archive_rollups (player_id, tournament_id, population)
  where player_id is not null;

-- Forecast internals stay private. Public clients can read the small output
-- table below, but never the model features, coefficients, or methodology JSON.
create table if not exists public.archive_model_runs (
  id text primary key,
  dataset_id text not null references public.archive_datasets (id) on delete cascade,
  dataset_content_sha256 text not null check (dataset_content_sha256 ~ '^[0-9a-f]{64}$'),
  model_kind text not null,
  trained_through date not null,
  training_set_count integer not null check (training_set_count >= 0),
  training_game_count integer not null check (training_game_count >= 0),
  backtest_brier numeric(8,6),
  backtest_log_loss numeric(8,6),
  methodology jsonb not null check (jsonb_typeof(methodology) = 'object'),
  created_at timestamptz not null default now()
);

alter table public.archive_model_runs add column if not exists dataset_content_sha256 text;
alter table public.archive_model_runs
  drop constraint if exists archive_model_runs_dataset_content_sha256_check;
alter table public.archive_model_runs
  add constraint archive_model_runs_dataset_content_sha256_check
  check (dataset_content_sha256 is null or dataset_content_sha256 ~ '^[0-9a-f]{64}$');

create table if not exists public.archive_forecast_events (
  id text primary key,
  model_run_id text not null references public.archive_model_runs (id) on delete cascade,
  canonical_name text not null,
  series_id text references public.archive_tournament_series (id) on delete set null,
  start_date date not null,
  entrant_source_url text not null,
  bracket_source_url text,
  simulation_count integer not null check (simulation_count >= 1000),
  data_cutoff date not null,
  notes text,
  published boolean not null default false,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (not published or published_at is not null)
);

create table if not exists public.archive_forecast_players (
  forecast_event_id text not null references public.archive_forecast_events (id) on delete cascade,
  player_id text not null references public.archive_players (id) on delete cascade,
  seed integer check (seed is null or seed >= 1),
  title_probability numeric(9,8) not null check (title_probability between 0 and 1),
  top_8_probability numeric(9,8) not null check (top_8_probability between 0 and 1),
  interval_low numeric(9,8) check (interval_low is null or interval_low between 0 and 1),
  interval_high numeric(9,8) check (interval_high is null or interval_high between 0 and 1),
  confidence text not null check (confidence in ('low', 'medium', 'high')),
  published boolean not null default false,
  primary key (forecast_event_id, player_id),
  check (interval_low is null or interval_high is null or interval_low <= interval_high)
);

create index if not exists archive_forecast_events_date_idx
  on public.archive_forecast_events (start_date, id)
  where published;
create index if not exists archive_forecast_players_probability_idx
  on public.archive_forecast_players (forecast_event_id, title_probability desc)
  where published;

-- Public readers see only explicitly published rows. Browser clients have no
-- insert/update/delete grants; the service role is the sole import path.
alter table public.archive_datasets enable row level security;
alter table public.archive_tournament_series enable row level security;
alter table public.archive_bundles enable row level security;
alter table public.archive_tournaments enable row level security;
alter table public.archive_players enable row level security;
alter table public.archive_player_aliases enable row level security;
alter table public.archive_player_rankings enable row level security;
alter table public.archive_sets enable row level security;
alter table public.archive_set_players enable row level security;
alter table public.archive_games enable row level security;
alter table public.archive_game_players enable row level security;
alter table public.archive_rollups enable row level security;
alter table public.archive_model_runs enable row level security;
alter table public.archive_forecast_events enable row level security;
alter table public.archive_forecast_players enable row level security;

drop policy if exists "published archive datasets read" on public.archive_datasets;
create policy "published archive datasets read" on public.archive_datasets
  for select to anon, authenticated using (published);
drop policy if exists "published archive tournament series read" on public.archive_tournament_series;
create policy "published archive tournament series read" on public.archive_tournament_series
  for select to anon, authenticated using (published);
drop policy if exists "published archive bundles read" on public.archive_bundles;
create policy "published archive bundles read" on public.archive_bundles
  for select to anon, authenticated using (published);
drop policy if exists "published archive tournaments read" on public.archive_tournaments;
create policy "published archive tournaments read" on public.archive_tournaments
  for select to anon, authenticated using (published);
drop policy if exists "published archive players read" on public.archive_players;
create policy "published archive players read" on public.archive_players
  for select to anon, authenticated using (published);
drop policy if exists "published archive aliases read" on public.archive_player_aliases;
create policy "published archive aliases read" on public.archive_player_aliases
  for select to anon, authenticated using (published);
drop policy if exists "published archive rankings read" on public.archive_player_rankings;
create policy "published archive rankings read" on public.archive_player_rankings
  for select to anon, authenticated using (published);
drop policy if exists "published archive sets read" on public.archive_sets;
create policy "published archive sets read" on public.archive_sets
  for select to anon, authenticated using (published);
drop policy if exists "published archive set players read" on public.archive_set_players;
create policy "published archive set players read" on public.archive_set_players
  for select to anon, authenticated using (published);
drop policy if exists "published archive games read" on public.archive_games;
create policy "published archive games read" on public.archive_games
  for select to anon, authenticated using (published);
drop policy if exists "published archive game players read" on public.archive_game_players;
create policy "published archive game players read" on public.archive_game_players
  for select to anon, authenticated using (published);
drop policy if exists "published archive rollups read" on public.archive_rollups;
create policy "published archive rollups read" on public.archive_rollups
  for select to anon, authenticated using (published);
drop policy if exists "published archive forecast events read" on public.archive_forecast_events;
create policy "published archive forecast events read" on public.archive_forecast_events
  for select to anon, authenticated using (published);
drop policy if exists "published archive forecast players read" on public.archive_forecast_players;
create policy "published archive forecast players read" on public.archive_forecast_players
  for select to anon, authenticated using (published);

grant select on public.archive_datasets to anon, authenticated;
grant select on public.archive_tournament_series to anon, authenticated;
grant select on public.archive_bundles to anon, authenticated;
grant select on public.archive_tournaments to anon, authenticated;
grant select on public.archive_players to anon, authenticated;
grant select on public.archive_player_aliases to anon, authenticated;
grant select on public.archive_player_rankings to anon, authenticated;
grant select on public.archive_sets to anon, authenticated;
grant select on public.archive_set_players to anon, authenticated;
grant select on public.archive_games to anon, authenticated;
grant select on public.archive_game_players to anon, authenticated;
grant select on public.archive_rollups to anon, authenticated;
grant select on public.archive_forecast_events to anon, authenticated;
grant select on public.archive_forecast_players to anon, authenticated;

revoke insert, update, delete on public.archive_datasets from anon, authenticated;
revoke insert, update, delete on public.archive_tournament_series from anon, authenticated;
revoke insert, update, delete on public.archive_bundles from anon, authenticated;
revoke insert, update, delete on public.archive_tournaments from anon, authenticated;
revoke insert, update, delete on public.archive_players from anon, authenticated;
revoke insert, update, delete on public.archive_player_aliases from anon, authenticated;
revoke insert, update, delete on public.archive_player_rankings from anon, authenticated;
revoke insert, update, delete on public.archive_sets from anon, authenticated;
revoke insert, update, delete on public.archive_set_players from anon, authenticated;
revoke insert, update, delete on public.archive_games from anon, authenticated;
revoke insert, update, delete on public.archive_game_players from anon, authenticated;
revoke insert, update, delete on public.archive_rollups from anon, authenticated;
revoke all on public.archive_model_runs from anon, authenticated;
revoke insert, update, delete on public.archive_forecast_events from anon, authenticated;
revoke insert, update, delete on public.archive_forecast_players from anon, authenticated;

grant all on public.archive_datasets to service_role;
grant all on public.archive_tournament_series to service_role;
grant all on public.archive_bundles to service_role;
grant all on public.archive_tournaments to service_role;
grant all on public.archive_players to service_role;
grant all on public.archive_player_aliases to service_role;
grant all on public.archive_player_rankings to service_role;
grant all on public.archive_sets to service_role;
grant all on public.archive_set_players to service_role;
grant all on public.archive_games to service_role;
grant all on public.archive_game_players to service_role;
grant all on public.archive_rollups to service_role;
grant all on public.archive_model_runs to service_role;
grant all on public.archive_forecast_events to service_role;
grant all on public.archive_forecast_players to service_role;

-- The loader stages every row as unpublished, validates the row counts locally,
-- and calls this once. Publication happens in one transaction, so browser
-- clients cannot observe a half-loaded dataset.
create or replace function public.publish_archive_dataset(p_dataset_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  expected jsonb;
  content_digest text;
  actual_count bigint;
  expected_count bigint;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role required';
  end if;

  select import_counts, content_sha256 into expected, content_digest
    from archive_datasets where id = p_dataset_id;
  if not found then raise exception 'unknown archive dataset %', p_dataset_id; end if;
  if content_digest is null or content_digest !~ '^[0-9a-f]{64}$' then
    raise exception 'archive dataset % lacks a valid content fingerprint', p_dataset_id;
  end if;

  expected_count := (expected ->> 'archive_tournaments')::bigint;
  select count(*) into actual_count from archive_tournaments where dataset_id = p_dataset_id;
  if actual_count <> expected_count then raise exception 'archive_tournaments count % != %', actual_count, expected_count; end if;
  expected_count := (expected ->> 'archive_bundles')::bigint;
  select count(*) into actual_count from archive_bundles where dataset_id = p_dataset_id;
  if actual_count <> expected_count then raise exception 'archive_bundles count % != %', actual_count, expected_count; end if;
  expected_count := (expected ->> 'archive_sets')::bigint;
  select count(*) into actual_count from archive_sets s join archive_tournaments t on t.id = s.tournament_id where t.dataset_id = p_dataset_id;
  if actual_count <> expected_count then raise exception 'archive_sets count % != %', actual_count, expected_count; end if;
  expected_count := (expected ->> 'archive_set_players')::bigint;
  select count(*) into actual_count from archive_set_players sp join archive_sets s on s.id = sp.set_id join archive_tournaments t on t.id = s.tournament_id where t.dataset_id = p_dataset_id;
  if actual_count <> expected_count then raise exception 'archive_set_players count % != %', actual_count, expected_count; end if;
  expected_count := (expected ->> 'archive_games')::bigint;
  select count(*) into actual_count from archive_games where dataset_id = p_dataset_id;
  if actual_count <> expected_count then raise exception 'archive_games count % != %', actual_count, expected_count; end if;
  expected_count := (expected ->> 'archive_game_players')::bigint;
  select count(*) into actual_count from archive_game_players gp join archive_games g on g.game_key = gp.game_key where g.dataset_id = p_dataset_id;
  if actual_count <> expected_count then raise exception 'archive_game_players count % != %', actual_count, expected_count; end if;
  expected_count := (expected ->> 'archive_rollups')::bigint;
  select count(*) into actual_count from archive_rollups where dataset_id = p_dataset_id;
  if actual_count <> expected_count then raise exception 'archive_rollups count % != %', actual_count, expected_count; end if;

  update archive_tournament_series s
    set published = true, updated_at = now()
    where exists (
      select 1 from archive_tournaments t
      where t.dataset_id = p_dataset_id and t.series_id = s.id
    );
  update archive_bundles set published = true where dataset_id = p_dataset_id;
  update archive_tournaments set published = true, updated_at = now() where dataset_id = p_dataset_id;
  update archive_players p set published = true, updated_at = now()
    where exists (
      select 1 from archive_player_rankings r where r.player_id = p.id
    ) or exists (
      select 1 from archive_game_players gp
      join archive_games g on g.game_key = gp.game_key
      where g.dataset_id = p_dataset_id and gp.player_id = p.id
    );
  update archive_player_aliases a set published = true
    where exists (select 1 from archive_players p where p.id = a.player_id and p.published);
  update archive_player_rankings r set published = true
    where exists (select 1 from archive_players p where p.id = r.player_id and p.published);
  update archive_sets s set published = true
    where exists (
      select 1 from archive_tournaments t
      where t.dataset_id = p_dataset_id and t.id = s.tournament_id
    );
  update archive_set_players sp set published = true
    where exists (select 1 from archive_sets s where s.id = sp.set_id and s.published);
  update archive_games set published = true where dataset_id = p_dataset_id;
  update archive_game_players gp set published = true
    where exists (
      select 1 from archive_games g
      where g.dataset_id = p_dataset_id and g.game_key = gp.game_key
    );
  update archive_rollups set published = true, updated_at = now() where dataset_id = p_dataset_id;
  update archive_datasets
    set published = true, published_at = now(), updated_at = now()
    where id = p_dataset_id;

end;
$$;

revoke all on function public.publish_archive_dataset(text) from public, anon, authenticated;
grant execute on function public.publish_archive_dataset(text) to service_role;

-- Forecast publication is separate from dataset publication because entrants
-- and brackets arrive later. The loader supplies the locally validated output
-- count; this function rechecks referential and probability completeness, then
-- exposes the event and every player row atomically.
create or replace function public.publish_archive_forecast(
  p_forecast_event_id text,
  p_expected_player_count integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dataset_id text;
  v_dataset_content_sha256 text;
  v_model_content_sha256 text;
  v_dataset_published boolean;
  v_event_published boolean;
  v_data_cutoff date;
  v_trained_through date;
  v_training_game_count integer;
  v_archive_game_count integer;
  v_player_count integer;
  v_title_sum numeric;
  v_top_8_sum numeric;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role required';
  end if;
  if p_expected_player_count is null or p_expected_player_count < 1 then
    raise exception 'expected player count must be positive';
  end if;

  select mr.dataset_id, d.content_sha256, mr.dataset_content_sha256,
      d.published, fe.published, fe.data_cutoff, mr.trained_through,
      mr.training_game_count
    into v_dataset_id, v_dataset_content_sha256, v_model_content_sha256,
      v_dataset_published, v_event_published, v_data_cutoff,
      v_trained_through, v_training_game_count
    from archive_forecast_events fe
    join archive_model_runs mr on mr.id = fe.model_run_id
    join archive_datasets d on d.id = mr.dataset_id
    where fe.id = p_forecast_event_id;
  if not found then
    raise exception 'unknown forecast event %', p_forecast_event_id;
  end if;
  if v_event_published then
    raise exception 'forecast event % is already published; use a new versioned id', p_forecast_event_id;
  end if;
  if not v_dataset_published then
    raise exception 'forecast dataset % must be published first', v_dataset_id;
  end if;
  if v_dataset_content_sha256 is null or v_model_content_sha256 is null
      or v_dataset_content_sha256 <> v_model_content_sha256 then
    raise exception 'forecast model fingerprint does not match dataset %', v_dataset_id;
  end if;
  if v_trained_through <> v_data_cutoff then
    raise exception 'model cutoff % does not match forecast cutoff %', v_trained_through, v_data_cutoff;
  end if;
  select count(*) into v_archive_game_count
    from archive_games where dataset_id = v_dataset_id;
  if v_training_game_count > v_archive_game_count then
    raise exception 'model training count % exceeds dataset game count %',
      v_training_game_count, v_archive_game_count;
  end if;

  select count(*), coalesce(sum(title_probability), 0), coalesce(sum(top_8_probability), 0)
    into v_player_count, v_title_sum, v_top_8_sum
    from archive_forecast_players
    where forecast_event_id = p_forecast_event_id;
  if v_player_count <> p_expected_player_count then
    raise exception 'forecast % expected % player rows but found %',
      p_forecast_event_id, p_expected_player_count, v_player_count;
  end if;
  if abs(v_title_sum - 1) > 0.0001 then
    raise exception 'forecast % title probabilities sum to %, expected 1', p_forecast_event_id, v_title_sum;
  end if;
  if abs(v_top_8_sum - least(8, v_player_count)) > 0.0001 then
    raise exception 'forecast % top-8 probabilities sum to %, expected %',
      p_forecast_event_id, v_top_8_sum, least(8, v_player_count);
  end if;
  if exists (
    select 1
    from archive_forecast_players fp
    join archive_players p on p.id = fp.player_id
    where fp.forecast_event_id = p_forecast_event_id and not p.published
  ) then
    raise exception 'forecast % references an unpublished player', p_forecast_event_id;
  end if;

  update archive_forecast_players
    set published = true
    where forecast_event_id = p_forecast_event_id;
  update archive_forecast_events
    set published = true, published_at = now(), updated_at = now()
    where id = p_forecast_event_id;
end;
$$;

revoke all on function public.publish_archive_forecast(text, integer) from public, anon, authenticated;
grant execute on function public.publish_archive_forecast(text, integer) to service_role;

comment on table public.archive_datasets is
  'Published metadata for public replay-derived datasets; never raw replay bytes.';
comment on table public.archive_games is
  'Public, derived game metadata only. No local file identity, path, or raw .slp data.';
comment on table public.archive_game_players is
  'Public per-game/player derived statistics. Anonymous slots have no public player identity.';
comment on table public.archive_rollups is
  'Query-ready broad Community and conservative Tournament benchmark aggregates.';
comment on table public.archive_model_runs is
  'Private forecast methodology and validation metadata; service-role access only.';
comment on table public.archive_forecast_players is
  'Small public forecast outputs; no model internals or replay-derived identifiers.';

commit;
