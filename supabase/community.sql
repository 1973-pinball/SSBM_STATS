-- Privacy-preserving Community Lab schema.
--
-- Run after schema.sql. Private packed GameRecords stay behind their per-user
-- RLS policy. The browser can read only community_snapshot, a precomputed
-- aggregate with no user ids, connect codes, display names, paths, file ids, or
-- exact timestamps. Community contribution is a separate, default-off consent.

-- Install/update atomically, and acquire the source-table locks before touching
-- the Community queue tables. A packed sync writes game_record_packs and then
-- queues its user; taking these locks later would invert that order and can
-- deadlock with a live sync while the triggers below are being replaced.
begin;
set local statement_timeout = '15min';
set local lock_timeout = '2min';
lock table public.game_records, public.game_record_packs in access exclusive mode;

create table if not exists public.community_consent (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  enabled boolean not null default false,
  consent_version text not null,
  updated_at timestamptz not null default now()
);

alter table public.community_consent enable row level security;

drop policy if exists "own community consent select" on public.community_consent;
create policy "own community consent select" on public.community_consent
  for select to authenticated using (auth.uid() = user_id);
drop policy if exists "own community consent insert" on public.community_consent;
create policy "own community consent insert" on public.community_consent
  for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "own community consent update" on public.community_consent;
create policy "own community consent update" on public.community_consent
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "own community consent delete" on public.community_consent;
create policy "own community consent delete" on public.community_consent
  for delete to authenticated using (auth.uid() = user_id);

grant select, insert, update, delete on public.community_consent to authenticated;

create table if not exists public.community_snapshot (
  snapshot_id text primary key default 'current' check (snapshot_id = 'current'),
  refreshed_at timestamptz not null default now(),
  contributor_count int not null default 0,
  player_game_count bigint not null default 0,
  min_contributors int not null default 1,
  min_games int not null default 100,
  min_players int not null default 25,
  payload jsonb not null default '{}'::jsonb
);

alter table public.community_snapshot enable row level security;
alter table public.community_snapshot alter column min_contributors set default 1;
alter table public.community_snapshot add column if not exists min_players int not null default 25;

drop policy if exists "community aggregate read" on public.community_snapshot;
create policy "community aggregate read" on public.community_snapshot
  for select to anon, authenticated using (true);

grant select on public.community_snapshot to anon, authenticated;
revoke insert, update, delete on public.community_snapshot from anon, authenticated;

-- Publish-time coarsening.
--
-- Publication requires 100 distinct games and 25 distinct connect-code player
-- identities in each cell. Either participant can supply an identity; uploader
-- accounts are informational. Codes are normalized and unioned across sources,
-- never summed per uploader. Missing codes and display names cannot identify a
-- unique player. Identity sets stay in private rollups, never the public payload.
-- These thresholds and rounded counts are not differential privacy; repeated
-- snapshots still reveal changes in the population.
--
-- Rates retain display precision and counts retain their existing buckets.
-- Apply eligibility to exact counts before rounding; refresh cadence still
-- limits how often changes to those aggregates can be observed.
create or replace function public.pub_bucket(value numeric, bucket numeric)
returns numeric
language sql
immutable
as $$ select case when value is null then null else round(value / bucket) * bucket end $$;

-- Merge private participant sets without multiplying the sample/metric sums.
-- Only privileged refresh functions call this; browsers cannot read the sets.
create or replace function public.community_count_players(player_sets jsonb)
returns int
language sql
immutable
set search_path = public, pg_temp
as $$
  select count(distinct player_key)::int
  from jsonb_array_elements(coalesce(player_sets, '[]'::jsonb)) player_set
  cross join lateral jsonb_array_elements_text(player_set) player_key
  where nullif(player_key, '') is not null
$$;
revoke all on function public.community_count_players(jsonb) from public, anon, authenticated;

-- Incremental refresh cache. Private inputs are processed only when games,
-- account codes, or consent change. Both sides of each unique eligible game
-- contribute player samples; identifiers never enter public aggregate keys.
-- Replacing a source user's rollup makes opt-out and deletes exact.
create table if not exists public.community_dirty_users (
  user_id uuid primary key references auth.users (id) on delete cascade,
  queued_at timestamptz not null default now()
);

create table if not exists public.community_user_rollups (
  user_id uuid primary key references auth.users (id) on delete cascade,
  game_count bigint not null,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.community_dirty_users enable row level security;
alter table public.community_user_rollups enable row level security;
revoke all on public.community_dirty_users from anon, authenticated;
revoke all on public.community_user_rollups from anon, authenticated;

-- Private membership index only: no replay payloads are duplicated here.
-- The lowest uploader UUID owns each game's two samples. Other uploaders still
-- count toward participation, but copies cannot inflate a published sample.
create table if not exists public.community_game_sources (
  user_id uuid not null references auth.users (id) on delete cascade,
  game_key text not null,
  primary key (user_id, game_key)
);
create index if not exists community_game_sources_by_game
  on public.community_game_sources (game_key, user_id);
alter table public.community_game_sources enable row level security;
revoke all on public.community_game_sources from public, anon, authenticated;

create or replace function public.mark_community_added_source_peers_dirty()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.community_dirty_users (user_id, queued_at)
  select distinct peer.user_id, now()
  from added_sources changed
  join public.community_game_sources peer using (game_key)
  join auth.users account on account.id = peer.user_id
  where peer.user_id <> changed.user_id
  on conflict (user_id) do update set queued_at = excluded.queued_at;
  return null;
end;
$$;

create or replace function public.mark_community_deleted_source_peers_dirty()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.community_dirty_users (user_id, queued_at)
  select distinct peer.user_id, now()
  from deleted_sources changed
  join public.community_game_sources peer using (game_key)
  join auth.users account on account.id = peer.user_id
  where peer.user_id <> changed.user_id
  on conflict (user_id) do update set queued_at = excluded.queued_at;
  return null;
end;
$$;

drop trigger if exists community_added_source_peers on public.community_game_sources;
create trigger community_added_source_peers
after insert on public.community_game_sources
referencing new table as added_sources
for each statement execute function public.mark_community_added_source_peers_dirty();
drop trigger if exists community_deleted_source_peers on public.community_game_sources;
create trigger community_deleted_source_peers
after delete on public.community_game_sources
referencing old table as deleted_sources
for each statement execute function public.mark_community_deleted_source_peers_dirty();

-- Reconcile only changed memberships. Replacing every key would endlessly
-- enqueue peers when two contributors uploaded the same games.
create or replace function public.refresh_community_game_sources(target_user uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  create temporary table if not exists community_next_game_keys (
    game_key text primary key
  ) on commit drop;
  truncate pg_temp.community_next_game_keys;
  insert into pg_temp.community_next_game_keys (game_key)
  select entry.key
  from public.game_record_packs packs
  join public.community_consent consent on consent.user_id = packs.user_id
    and consent.enabled and consent.consent_version = '2026-08-24'
  cross join lateral jsonb_each(packs.records) entry
  where packs.user_id = target_user
    and case
      when (packs.versions->>entry.key) ~ '^[0-9]+$' then (packs.versions->>entry.key)::int
      else 0
    end >= 3
    and coalesce((entry.value->>'isTeams')::boolean, false) = false
    and jsonb_array_length(entry.value->'players') = 2
    and not (entry.value ? 'parseError')
    and entry.value->>'playedAt' is not null
    and (entry.value->>'stageId')::int in (2, 3, 8, 28, 31, 32)
    and 1 = (
      select count(*) from jsonb_array_elements(entry.value->'players') p
      join public.user_codes c on c.user_id = target_user and c.code = p->>'connectCode'
    );

  delete from public.community_game_sources old
  where old.user_id = target_user and not exists (
    select 1 from pg_temp.community_next_game_keys next where next.game_key = old.game_key
  );
  insert into public.community_game_sources (user_id, game_key)
  select target_user, game_key from pg_temp.community_next_game_keys
  on conflict do nothing;
end;
$$;

revoke all on function public.refresh_community_game_sources(uuid) from public, anon, authenticated;
revoke all on function public.mark_community_added_source_peers_dirty() from public, anon, authenticated;
revoke all on function public.mark_community_deleted_source_peers_dirty() from public, anon, authenticated;

create or replace function public.mark_community_user_dirty()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  affected_user uuid;
begin
  affected_user := case when tg_op = 'DELETE' then old.user_id else new.user_id end;
  -- Auth deletion cascades through these tables. Do not recreate a queue row
  -- for a deleted account; source-membership deletes enqueue surviving peers.
  if not exists (select 1 from auth.users where id = affected_user) then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  insert into public.community_dirty_users (user_id, queued_at)
  values (affected_user, now())
  on conflict (user_id) do update set queued_at = excluded.queued_at;

  if tg_op = 'UPDATE' and old.user_id is distinct from new.user_id then
    insert into public.community_dirty_users (user_id, queued_at)
    values (old.user_id, now())
    on conflict (user_id) do update set queued_at = excluded.queued_at;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

-- A packed merge can touch many buckets in one statement. Transition tables
-- reduce that to one dirty-user upsert per affected account rather than one
-- write per changed pack.
create or replace function public.mark_community_changed_game_users_dirty()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.community_dirty_users (user_id, queued_at)
  select distinct user_id, now() from changed_game_rows
  on conflict (user_id) do update set queued_at = excluded.queued_at;
  return null;
end;
$$;

create or replace function public.mark_community_deleted_game_users_dirty()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.community_dirty_users (user_id, queued_at)
  select distinct changed.user_id, now() from deleted_game_rows changed
  join auth.users account on account.id = changed.user_id
  on conflict (user_id) do update set queued_at = excluded.queued_at;
  return null;
end;
$$;

drop trigger if exists community_dirty_game_records on public.game_records;
drop trigger if exists community_dirty_game_records_insert on public.game_records;
drop trigger if exists community_dirty_game_records_update on public.game_records;
drop trigger if exists community_dirty_game_records_delete on public.game_records;
drop trigger if exists community_dirty_game_record_packs_insert on public.game_record_packs;
drop trigger if exists community_dirty_game_record_packs_update on public.game_record_packs;
drop trigger if exists community_dirty_game_record_packs_delete on public.game_record_packs;
create trigger community_dirty_game_record_packs_insert
after insert on public.game_record_packs
referencing new table as changed_game_rows
for each statement execute function public.mark_community_changed_game_users_dirty();
create trigger community_dirty_game_record_packs_update
after update on public.game_record_packs
referencing new table as changed_game_rows
for each statement execute function public.mark_community_changed_game_users_dirty();
create trigger community_dirty_game_record_packs_delete
after delete on public.game_record_packs
referencing old table as deleted_game_rows
for each statement execute function public.mark_community_deleted_game_users_dirty();

drop trigger if exists community_dirty_user_codes on public.user_codes;
create trigger community_dirty_user_codes
after insert or update or delete on public.user_codes
for each row execute function public.mark_community_user_dirty();

drop trigger if exists community_dirty_consent on public.community_consent;
create trigger community_dirty_consent
after insert or update or delete on public.community_consent
for each row execute function public.mark_community_user_dirty();

revoke all on function public.mark_community_user_dirty() from public, anon, authenticated;
revoke all on function public.mark_community_changed_game_users_dirty() from public, anon, authenticated;
revoke all on function public.mark_community_deleted_game_users_dirty() from public, anon, authenticated;

create or replace function public.refresh_community_user_rollup(target_user uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
delete from public.community_user_rollups where user_id = target_user;

with
params as (
  select '2026-08-24'::text as consent_version
),
-- This source is used once for scalar stats and once for moves. Inlining makes
-- PostgreSQL project only the fields each path needs instead of spooling the
-- full GameRecord JSON between them.
contributed_games as not materialized (
  select
    g.user_id,
    coalesce(
      g.game_key,
      (g.data->>'playedAt') || '|' || (g.data->>'stageId') || '|' || (
        select string_agg(coalesce(p->>'connectCode', 'p' || (p->>'port') || ':' || (p->>'characterId')), '+' order by coalesce(p->>'connectCode', 'p' || (p->>'port') || ':' || (p->>'characterId')))
        from jsonb_array_elements(g.data->'players') p
      )
    ) as private_game_key,
    g.data,
    own.side as own_side,
    own.ord - 1 as own_index,
    opp.side as opp_side
  from (
    select packs.user_id, entry.key as game_key, entry.value as data
    from public.game_record_packs packs
    cross join lateral jsonb_each(packs.records) entry
    join public.community_game_sources source
      on source.user_id = packs.user_id and source.game_key = entry.key
    where packs.user_id = target_user
      and case
        when (packs.versions->>entry.key) ~ '^[0-9]+$' then (packs.versions->>entry.key)::int
        else 0
      end >= 3
      and not exists (
        select 1 from public.community_game_sources earlier
        where earlier.game_key = entry.key and earlier.user_id < target_user
      )
  ) g
  cross join params
  join public.community_consent consent
    on consent.user_id = g.user_id
   and consent.enabled
   and consent.consent_version = params.consent_version
  cross join lateral (
    select p.side, p.ord
    from jsonb_array_elements(g.data->'players') with ordinality p(side, ord)
    join public.user_codes c on c.user_id = g.user_id and c.code = p.side->>'connectCode'
    order by p.ord
    limit 1
  ) own
  cross join lateral (
    select p.side
    from jsonb_array_elements(g.data->'players') with ordinality p(side, ord)
    where p.ord <> own.ord
    order by p.ord
    limit 1
  ) opp
  where g.user_id = target_user
    and coalesce((g.data->>'isTeams')::boolean, false) = false
    and jsonb_array_length(g.data->'players') = 2
    and not (g.data ? 'parseError')
    and (g.data->>'playedAt') is not null
    and (g.data->>'stageId')::int in (2, 3, 8, 28, 31, 32)
    and 1 = (
      select count(*)
      from jsonb_array_elements(g.data->'players') p
      join public.user_codes c on c.user_id = g.user_id and c.code = p->>'connectCode'
    )
),
-- A replay is one game with two player samples. Keep the source contributor
-- for privacy thresholds, but orient each side independently for every metric.
eligible as not materialized (
  select g.user_id, g.private_game_key, g.data,
         side.own_side, side.own_index, side.opp_side
  from contributed_games g
  cross join lateral (values
    (g.own_side, g.own_index, g.opp_side),
    (g.opp_side, 1 - g.own_index, g.own_side)
  ) side(own_side, own_index, opp_side)
),
-- All writers place a content-derived game key in its deterministic bucket.
-- A JSON object has unique keys, so normal packed data has no duplicate row to
-- remove here; sorting the full payload through DISTINCT only creates a large
-- temporary file left over from the legacy row-table plan.
base as materialized (
  select
    user_id,
    private_game_key,
    nullif(upper(btrim(own_side->>'connectCode')), '') as player_key,
    nullif(upper(btrim(opp_side->>'connectCode')), '') as opponent_player_key,
    (data->>'playedAt')::timestamptz as played_at,
    date_trunc('month', (data->>'playedAt')::timestamptz)::date as month,
    (data->>'durationFrames')::numeric / 60.0 as duration_seconds,
    (data->>'stageId')::int as stage_id,
    case when data->>'gameType' in ('ranked', 'unranked', 'direct', 'offline') then data->>'gameType' else 'unknown' end as game_type,
    (own_side->>'characterId')::int as character_id,
    (opp_side->>'characterId')::int as opponent_character_id,
    case
      when data->>'winnerIndex' is null then null
      when (data->>'winnerIndex')::int = own_index then 1
      else 0
    end as win,
    coalesce((own_side->>'lCancelSuccess')::numeric, 0) as l_cancel_success,
    coalesce((own_side->>'lCancelFail')::numeric, 0) as l_cancel_fail,
    own_side ? 'techs' as has_techs,
    coalesce((own_side->'techs'->>'inPlace')::numeric, 0) as tech_in_place,
    coalesce((own_side->'techs'->>'toward')::numeric, 0) as tech_in,
    coalesce((own_side->'techs'->>'away')::numeric, 0) as tech_away,
    coalesce((own_side->'techs'->>'missed')::numeric, 0) as tech_missed,
    nullif(own_side->>'openingsPerKill', '')::numeric as openings_per_kill,
    nullif(own_side->>'damagePerOpening', '')::numeric as damage_per_opening,
    nullif(own_side->>'inputsPerMinute', '')::numeric as inputs_per_minute,
    coalesce((own_side->'actions'->>'rolls')::numeric, 0) as action_rolls,
    coalesce((own_side->'actions'->>'airDodges')::numeric, 0) as action_air_dodges,
    coalesce((own_side->'actions'->>'spotDodges')::numeric, 0) as action_spot_dodges,
    coalesce((own_side->'actions'->>'wavedashes')::numeric, 0) as action_wavedashes,
    coalesce((own_side->'actions'->>'wavelands')::numeric, 0) as action_wavelands,
    coalesce((own_side->'actions'->>'dashDances')::numeric, 0) as action_dash_dances,
    coalesce((own_side->'actions'->>'ledgeGrabs')::numeric, 0) as action_ledge_grabs,
    coalesce((own_side->'actions'->>'crouchCancels')::numeric, 0) as action_crouch_cancels,
    coalesce((own_side->'actions'->>'grabs')::numeric, 0) as action_grabs
  from eligible
),
periods(lookback_days) as (
  values (30::int), (90::int), (180::int), (365::int), (null::int)
),
-- Keep this materialized because five downstream aggregates reuse it, but do
-- not carry move_stats through it. That JSON is by far the widest value in a
-- game row; copying it into every lookback cohort can fill pgsql_tmp for a
-- large library before any aggregate is produced.
windowed as materialized (
  select
    p.lookback_days,
    b.private_game_key,
    b.player_key,
    b.opponent_player_key,
    b.character_id,
    b.opponent_character_id,
    b.stage_id,
    b.game_type,
    b.win,
    b.l_cancel_success,
    b.l_cancel_fail,
    b.has_techs,
    b.tech_in_place,
    b.tech_in,
    b.tech_away,
    b.tech_missed,
    b.action_rolls,
    b.action_air_dodges,
    b.action_spot_dodges,
    b.action_wavedashes,
    b.action_wavelands,
    b.action_dash_dances,
    b.action_ledge_grabs,
    b.action_crouch_cancels,
    b.action_grabs
  from base b
  cross join periods p
  where p.lookback_days is null
     or b.played_at >= (
       ((now() at time zone 'UTC')::date - p.lookback_days)::timestamp at time zone 'UTC'
     )
),
active as (
  select count(*)::bigint as games from base
),
matchup_rollup as (
  select
    lookback_days,
    character_id,
    opponent_character_id,
    coalesce(stage_id, 0)::int as stage_id,
    coalesce(game_type, 'all') as game_type,
    count(distinct private_game_key)::bigint as unique_games,
    array_remove(array_agg(distinct player_key) || array_agg(distinct opponent_player_key), null) as player_keys,
    count(*)::bigint as games,
    sum(win)::bigint as wins
  from windowed
  where win is not null
  group by lookback_days, grouping sets (
    (character_id, opponent_character_id),
    (character_id, opponent_character_id, stage_id),
    (character_id, opponent_character_id, game_type),
    (character_id, opponent_character_id, stage_id, game_type)
  )
),
benchmark_rollup as (
  select
    (case when grouping(character_id) = 1 then -1 else character_id end)::int as character_id,
    count(distinct private_game_key)::bigint as unique_games,
    array_remove(array_agg(distinct player_key) || array_agg(distinct opponent_player_key), null) as player_keys,
    count(*)::bigint as games,
    case when sum(l_cancel_success + l_cancel_fail) > 0
      then 100.0 * sum(l_cancel_success) / sum(l_cancel_success + l_cancel_fail)
    end as l_cancel,
    avg(openings_per_kill) as openings_per_kill,
    avg(damage_per_opening) as damage_per_opening,
    avg(inputs_per_minute) as inputs_per_minute
  from base
  group by grouping sets ((character_id), ())
  having count(*) >= 5
),
execution_rollup as (
  select
    lookback_days,
    (case when grouping(character_id) = 1 then -1 else character_id end)::int as character_id,
    count(distinct private_game_key)::bigint as unique_games,
    array_remove(array_agg(distinct player_key) || array_agg(distinct opponent_player_key), null) as player_keys,
    count(*)::bigint as games,
    sum(l_cancel_success) as l_cancel_success,
    sum(l_cancel_fail) as l_cancel_fail,
    sum(tech_in_place) as tech_in_place,
    sum(tech_in) as tech_in,
    sum(tech_away) as tech_away,
    sum(tech_missed) as tech_missed,
    sum(action_rolls) as action_rolls,
    sum(action_air_dodges) as action_air_dodges,
    sum(action_spot_dodges) as action_spot_dodges,
    sum(action_wavedashes) as action_wavedashes,
    sum(action_wavelands) as action_wavelands,
    sum(action_dash_dances) as action_dash_dances,
    sum(action_ledge_grabs) as action_ledge_grabs,
    sum(action_crouch_cancels) as action_crouch_cancels,
    sum(action_grabs) as action_grabs
  from windowed
  where has_techs and character_id between 0 and 25
  group by lookback_days, grouping sets ((character_id), ())
),
character_totals as (
  select lookback_days, character_id, count(*)::bigint as games
  from windowed
  group by lookback_days, character_id
),
-- Collapse raw action ids into the public move categories once per game. The
-- old plan crossed games with all five periods before jsonb_each(), expanding
-- and grouping the same move table up to five times. Only these narrow rows
-- need to be copied into the lookback cohorts.
move_per_game_base as (
  select
    (b.data->>'playedAt')::timestamptz as played_at,
    b.private_game_key,
    b.own_index as player_index,
    nullif(upper(btrim(b.own_side->>'connectCode')), '') as player_key,
    nullif(upper(btrim(b.opp_side->>'connectCode')), '') as opponent_player_key,
    (b.own_side->>'characterId')::int as character_id,
    case
      when m.key::int in (2,3,4,5) then 'jab'
      when m.key::int = 6 then 'dash'
      when m.key::int = 7 then 'ftilt'
      when m.key::int = 8 then 'utilt'
      when m.key::int = 9 then 'dtilt'
      when m.key::int = 10 then 'fsmash'
      when m.key::int = 11 then 'usmash'
      when m.key::int = 12 then 'dsmash'
      when m.key::int = 13 then 'nair'
      when m.key::int = 14 then 'fair'
      when m.key::int = 15 then 'bair'
      when m.key::int = 16 then 'uair'
      when m.key::int = 17 then 'dair'
      when m.key::int = 18 then 'neutral-b'
      when m.key::int = 19 then 'side-b'
      when m.key::int = 20 then 'up-b'
      when m.key::int = 21 then 'down-b'
      when m.key::int in (50,51) then 'getup'
      when m.key::int = 52 then 'pummel'
      when m.key::int = 53 then 'fthrow'
      when m.key::int = 54 then 'bthrow'
      when m.key::int = 55 then 'uthrow'
      when m.key::int = 56 then 'dthrow'
      when m.key::int in (61,62) then 'edge'
      else 'other'
    end as move_key,
    sum(coalesce((m.value->>'landed')::numeric, 0)) as landed,
    sum(coalesce((m.value->>'damage')::numeric, 0)) as damage,
    sum(coalesce((m.value->>'kills')::numeric, 0)) as kills,
    sum(coalesce((m.value->>'killPctSum')::numeric, 0)) as kill_pct_sum,
    sum(coalesce((m.value->>'openings')::numeric, 0)) as openings,
    sum(coalesce((m.value->>'openingDmg')::numeric, 0)) as opening_damage,
    sum(coalesce((m.value->>'lcSuccess')::numeric, 0)) as l_cancel_success,
    sum(coalesce((m.value->>'lcFail')::numeric, 0)) as l_cancel_fail,
    sum((m.value->>'attempts')::numeric) filter (where m.value ? 'attempts') as attempts,
    bool_or(m.value ? 'attempts') as has_attempts
  from eligible b
  cross join lateral jsonb_each(coalesce(b.own_side->'moveStats', '{}'::jsonb)) m
  group by (b.data->>'playedAt')::timestamptz, b.private_game_key, b.own_index,
           (b.own_side->>'characterId')::int, move_key, player_key, opponent_player_key
),
move_per_game as (
  select
    p.lookback_days,
    m.private_game_key,
    m.player_key,
    m.opponent_player_key,
    m.character_id,
    m.move_key,
    m.landed,
    m.damage,
    m.kills,
    m.kill_pct_sum,
    m.openings,
    m.opening_damage,
    m.l_cancel_success,
    m.l_cancel_fail,
    m.attempts,
    m.has_attempts
  from move_per_game_base m
  cross join periods p
  where p.lookback_days is null
     or m.played_at >= (
       ((now() at time zone 'UTC')::date - p.lookback_days)::timestamp at time zone 'UTC'
     )
),
move_rollup as (
  select
    m.lookback_days,
    m.character_id,
    m.move_key,
    c.games as character_games,
    count(distinct m.private_game_key)::bigint as unique_games,
    array_remove(array_agg(distinct m.player_key) || array_agg(distinct m.opponent_player_key), null) as player_keys,
    count(*)::bigint as move_games,
    sum(m.attempts) filter (where m.has_attempts) as attempts,
    count(*) filter (where m.has_attempts)::bigint as attempt_games,
    sum(m.landed) as landed,
    sum(m.damage) as damage,
    sum(m.kills) as kills,
    sum(m.kill_pct_sum) as kill_pct_sum,
    sum(m.openings) as openings,
    sum(m.opening_damage) as opening_damage,
    sum(m.l_cancel_success) as l_cancel_success,
    sum(m.l_cancel_fail) as l_cancel_fail
  from move_per_game m
  join character_totals c
    on c.character_id = m.character_id
   and c.lookback_days is not distinct from m.lookback_days
  group by m.lookback_days, m.character_id, m.move_key, c.games
),
month_rollup as (
  select
    month,
    count(distinct private_game_key)::bigint as unique_games,
    array_remove(array_agg(distinct player_key) || array_agg(distinct opponent_player_key), null) as player_keys,
    count(*)::bigint as games,
    sum(duration_seconds) as duration_seconds,
    count(*) filter (where game_type = 'ranked')::bigint as ranked,
    count(*) filter (where game_type = 'unranked')::bigint as unranked,
    count(*) filter (where game_type = 'direct')::bigint as direct,
    count(*) filter (where game_type = 'offline')::bigint as offline
  from base
  group by month
),
character_rollup as (
  select
    lookback_days,
    character_id,
    count(distinct private_game_key)::bigint as unique_games,
    array_remove(array_agg(distinct player_key) || array_agg(distinct opponent_player_key), null) as player_keys,
    count(*)::bigint as games,
    sum(win) filter (where win is not null)::bigint as wins,
    count(win)::bigint as decided
  from windowed
  group by lookback_days, character_id
),
stage_rollup as (
  select stage_id,
    count(distinct private_game_key)::bigint as unique_games,
    array_remove(array_agg(distinct player_key) || array_agg(distinct opponent_player_key), null) as player_keys,
    count(*)::bigint as games, sum(duration_seconds) as duration_seconds
  from base
  group by stage_id
),
assembled as (
  select jsonb_build_object(
    'matchups', coalesce((select jsonb_agg(jsonb_build_object(
      'playerKeys', player_keys, 'uniqueGames', unique_games,
      'lookbackDays', lookback_days,
      'characterId', character_id, 'opponentCharacterId', opponent_character_id,
      'stageId', stage_id, 'gameType', game_type, 'games', games, 'wins', wins
    )) from matchup_rollup), '[]'::jsonb),
    'benchmarks', coalesce((select jsonb_agg(jsonb_build_object(
      'playerKeys', player_keys, 'uniqueGames', unique_games,
      'characterId', character_id, 'games', games, 'lCancel', l_cancel,
      'openingsPerKill', openings_per_kill, 'damagePerOpening', damage_per_opening,
      'inputsPerMinute', inputs_per_minute
    )) from benchmark_rollup), '[]'::jsonb),
    'execution', coalesce((select jsonb_agg(jsonb_build_object(
      'playerKeys', player_keys, 'uniqueGames', unique_games,
      'lookbackDays', lookback_days,
      'characterId', character_id, 'games', games,
      'lCancelSuccess', l_cancel_success, 'lCancelFail', l_cancel_fail,
      'techInPlace', tech_in_place, 'techIn', tech_in,
      'techAway', tech_away, 'techMissed', tech_missed,
      'techInPlaceCount', tech_in_place, 'techInCount', tech_in,
      'techAwayCount', tech_away,
      'actionCounts', jsonb_build_object(
        'rolls', action_rolls,
        'airDodges', action_air_dodges,
        'spotDodges', action_spot_dodges,
        'wavedashes', action_wavedashes,
        'wavelands', action_wavelands,
        'dashDances', action_dash_dances,
        'ledgeGrabs', action_ledge_grabs,
        'crouchCancels', action_crouch_cancels,
        'grabs', action_grabs
      )
    )) from execution_rollup), '[]'::jsonb),
    'moves', coalesce((select jsonb_agg(jsonb_build_object(
      'playerKeys', player_keys, 'uniqueGames', unique_games,
      'lookbackDays', lookback_days,
      'characterId', character_id, 'moveKey', move_key,
      'characterGames', character_games, 'moveGames', move_games,
      'attempts', attempts, 'attemptGames', attempt_games,
      'landed', landed, 'damage', damage, 'kills', kills,
      'killPctSum', kill_pct_sum, 'openings', openings,
      'openingDamage', opening_damage, 'lCancelSuccess', l_cancel_success,
      'lCancelFail', l_cancel_fail
    )) from move_rollup), '[]'::jsonb),
    'months', coalesce((select jsonb_agg(jsonb_build_object(
      'playerKeys', player_keys, 'uniqueGames', unique_games,
      'month', month, 'games', games, 'durationSeconds', duration_seconds,
      'ranked', ranked, 'unranked', unranked, 'direct', direct, 'offline', offline
    )) from month_rollup), '[]'::jsonb),
    'characters', coalesce((select jsonb_agg(jsonb_build_object(
      'playerKeys', player_keys, 'uniqueGames', unique_games,
      'lookbackDays', lookback_days,
      'characterId', character_id, 'games', games,
      'wins', coalesce(wins, 0), 'decided', decided
    )) from character_rollup), '[]'::jsonb),
    'stages', coalesce((select jsonb_agg(jsonb_build_object(
      'playerKeys', player_keys, 'uniqueGames', unique_games,
      'stageId', stage_id, 'games', games, 'durationSeconds', duration_seconds
    )) from stage_rollup), '[]'::jsonb)
  ) as payload
)
insert into public.community_user_rollups (user_id, game_count, payload, updated_at)
select target_user, active.games, assembled.payload, now()
from active, assembled
where active.games > 0
on conflict (user_id) do update set
  game_count = excluded.game_count,
  payload = excluded.payload,
  updated_at = excluded.updated_at;
$$;

revoke all on function public.refresh_community_user_rollup(uuid) from public, anon, authenticated;

-- With no dirty users, the incremental snapshot refresh
-- this returns after one indexed existence check and performs no game scan.
create or replace function public.refresh_community_snapshot()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  dirty_user uuid;
  changed boolean := false;
begin
  -- A second scheduler must not race source ownership or consume its queue.
  perform pg_advisory_xact_lock(hashtext('community_snapshot_refresh'));
  -- Rolling cohorts age even when nobody uploads or edits a game. Queue one
  -- refresh per contributor on the first cron run of each UTC day so a game
  -- that crosses a lookback boundary leaves the private cache on schedule.
  if exists (
    select 1
    from public.community_snapshot
    where snapshot_id = 'current'
      and (refreshed_at at time zone 'UTC')::date < (now() at time zone 'UTC')::date
  ) then
    insert into public.community_dirty_users (user_id, queued_at)
    select user_id, now() from public.community_consent
    on conflict (user_id) do update set queued_at = excluded.queued_at;
  end if;

  loop
    select d.user_id into dirty_user
    from public.community_dirty_users d
    order by d.queued_at, d.user_id
    limit 1 for update;
    exit when not found;
    changed := true;
    perform public.refresh_community_game_sources(dirty_user);
    perform public.refresh_community_user_rollup(dirty_user);
    delete from public.community_dirty_users where user_id = dirty_user;
    -- Source changes can enqueue another uploader of the same game. Drain
    -- those peers too, so ownership transfers never leave a mixed snapshot.
  end loop;

  if not changed and exists (
    select 1 from public.community_snapshot
    where snapshot_id = 'current' and min_contributors = 1 and min_games = 100
      and payload->>'thresholdVersion' = 'unique-players-v2'
  ) then
    return;
  end if;

  with
  params as (
    -- Keep min_contributors for compatibility with existing snapshot readers.
    -- Sources are informational; distinct participants and games gate cells.
    select 1::int as min_contributors, 25::int as min_players, 100::int as min_games
  ),
  active as (
    select
      (select count(distinct user_id)::int from public.community_game_sources) as contributors,
      public.pub_bucket(coalesce(sum(game_count), 0), 500)::bigint as player_games
    from public.community_user_rollups
    where game_count > 0
  ),
  matchup_user as (
    select
      r.user_id,
      coalesce(j->'playerKeys', '[]'::jsonb) as player_keys,
      coalesce((j->>'uniqueGames')::bigint, 0) as unique_games,
      (j->>'lookbackDays')::int as lookback_days,
      (j->>'characterId')::int as character_id,
      (j->>'opponentCharacterId')::int as opponent_character_id,
      (j->>'stageId')::int as stage_id,
      j->>'gameType' as game_type,
      (j->>'games')::bigint as games,
      (j->>'wins')::bigint as wins
    from public.community_user_rollups r
    cross join lateral jsonb_array_elements(coalesce(r.payload->'matchups', '[]'::jsonb)) j
  ),
  matchup_rollup as (
    select lookback_days, character_id, opponent_character_id, stage_id, game_type,
           sum(games)::bigint as games, count(*)::int as contributors,
      public.community_count_players(jsonb_agg(player_keys)) as players,
      sum(unique_games)::bigint as unique_games,
           sum(wins)::bigint as wins
    from matchup_user, params
    group by lookback_days, character_id, opponent_character_id, stage_id, game_type,
             params.min_players, params.min_games
    having sum(unique_games) >= params.min_games
       and public.community_count_players(jsonb_agg(player_keys)) >= params.min_players
  ),
  character_stage_rollup as (
    -- Combine private opponent cells before suppression. Each game's opponent
    -- character is fixed, so these distinct-game counts are disjoint. Mirrors
    -- already count once for unique_games and twice for player samples.
    select lookback_days, character_id, stage_id, game_type,
      sum(games)::bigint as games,
      count(distinct user_id)::int as contributors,
      public.community_count_players(jsonb_agg(player_keys)) as players,
      sum(unique_games)::bigint as unique_games,
      sum(wins)::bigint as wins
    from matchup_user, params
    where stage_id <> 0
    group by lookback_days, character_id, stage_id, game_type,
             params.min_players, params.min_games
    having sum(unique_games) >= params.min_games
       and public.community_count_players(jsonb_agg(player_keys)) >= params.min_players
  ),
  benchmark_user as (
    select
      r.user_id,
      coalesce(j->'playerKeys', '[]'::jsonb) as player_keys,
      coalesce((j->>'uniqueGames')::bigint, 0) as unique_games,
      (j->>'characterId')::int as character_id,
      (j->>'games')::bigint as games,
      (j->>'lCancel')::numeric as l_cancel,
      (j->>'openingsPerKill')::numeric as openings_per_kill,
      (j->>'damagePerOpening')::numeric as damage_per_opening,
      (j->>'inputsPerMinute')::numeric as inputs_per_minute
    from public.community_user_rollups r
    cross join lateral jsonb_array_elements(coalesce(r.payload->'benchmarks', '[]'::jsonb)) j
  ),
  benchmark_rollup as (
    select
      character_id,
      sum(games)::bigint as games,
      count(*)::int as contributors,
      public.community_count_players(jsonb_agg(player_keys)) as players,
      sum(unique_games)::bigint as unique_games,
      case when public.community_count_players(jsonb_agg(player_keys) filter (where l_cancel is not null)) >= params.min_players then
        (percentile_cont(array[0.25, 0.5, 0.75]) within group (order by l_cancel) filter (where l_cancel is not null))::numeric[]
      end as l_cancel_q,
      case when public.community_count_players(jsonb_agg(player_keys) filter (where openings_per_kill is not null)) >= params.min_players then
        (percentile_cont(array[0.25, 0.5, 0.75]) within group (order by openings_per_kill) filter (where openings_per_kill is not null))::numeric[]
      end as opk_q,
      case when public.community_count_players(jsonb_agg(player_keys) filter (where damage_per_opening is not null)) >= params.min_players then
        (percentile_cont(array[0.25, 0.5, 0.75]) within group (order by damage_per_opening) filter (where damage_per_opening is not null))::numeric[]
      end as dpo_q,
      case when public.community_count_players(jsonb_agg(player_keys) filter (where inputs_per_minute is not null)) >= params.min_players then
        (percentile_cont(array[0.25, 0.5, 0.75]) within group (order by inputs_per_minute) filter (where inputs_per_minute is not null))::numeric[]
      end as ipm_q
    from benchmark_user, params
    group by character_id, params.min_players, params.min_games
    having sum(unique_games) >= params.min_games
       and public.community_count_players(jsonb_agg(player_keys)) >= params.min_players
  ),
  execution_user as (
    select
      r.user_id,
      coalesce(j->'playerKeys', '[]'::jsonb) as player_keys,
      coalesce((j->>'uniqueGames')::bigint, 0) as unique_games,
      (j->>'lookbackDays')::int as lookback_days,
      (j->>'characterId')::int as character_id,
      (j->>'games')::bigint as games,
      (j->>'lCancelSuccess')::numeric as l_cancel_success,
      (j->>'lCancelFail')::numeric as l_cancel_fail,
      (j->>'techInPlace')::numeric as tech_in_place,
      (j->>'techIn')::numeric as tech_in,
      (j->>'techAway')::numeric as tech_away,
      (j->>'techMissed')::numeric as tech_missed,
      coalesce((j->'actionCounts'->>'rolls')::numeric, 0) as action_rolls,
      coalesce((j->'actionCounts'->>'airDodges')::numeric, 0) as action_air_dodges,
      coalesce((j->'actionCounts'->>'spotDodges')::numeric, 0) as action_spot_dodges,
      coalesce((j->'actionCounts'->>'wavedashes')::numeric, 0) as action_wavedashes,
      coalesce((j->'actionCounts'->>'wavelands')::numeric, 0) as action_wavelands,
      coalesce((j->'actionCounts'->>'dashDances')::numeric, 0) as action_dash_dances,
      coalesce((j->'actionCounts'->>'ledgeGrabs')::numeric, 0) as action_ledge_grabs,
      coalesce((j->'actionCounts'->>'crouchCancels')::numeric, 0) as action_crouch_cancels,
      coalesce((j->'actionCounts'->>'grabs')::numeric, 0) as action_grabs
    from public.community_user_rollups r
    cross join lateral jsonb_array_elements(coalesce(r.payload->'execution', '[]'::jsonb)) j
  ),
  execution_rollup as (
    select
      lookback_days,
      character_id,
      sum(games)::bigint as games,
      count(*)::int as contributors,
      public.community_count_players(jsonb_agg(player_keys)) as players,
      sum(unique_games)::bigint as unique_games,
      case when sum(l_cancel_success + l_cancel_fail) > 0
        then 100.0 * sum(l_cancel_success) / sum(l_cancel_success + l_cancel_fail)
      end as l_cancel_success,
      case when sum(tech_in_place + tech_in + tech_away + tech_missed) > 0
        then 100.0 * sum(tech_in_place + tech_in + tech_away)
          / sum(tech_in_place + tech_in + tech_away + tech_missed)
      end as ground_tech_success,
      case when sum(tech_in_place + tech_in + tech_away) > 0
        then 100.0 * sum(tech_in_place) / sum(tech_in_place + tech_in + tech_away)
      end as ground_tech_in_place,
      case when sum(tech_in_place + tech_in + tech_away) > 0
        then 100.0 * sum(tech_in) / sum(tech_in_place + tech_in + tech_away)
      end as ground_tech_in,
      case when sum(tech_in_place + tech_in + tech_away) > 0
        then 100.0 * sum(tech_away) / sum(tech_in_place + tech_in + tech_away)
      end as ground_tech_away,
      sum(tech_in_place) as tech_in_place_count,
      sum(tech_in) as tech_in_count,
      sum(tech_away) as tech_away_count,
      sum(action_rolls) as action_rolls,
      sum(action_air_dodges) as action_air_dodges,
      sum(action_spot_dodges) as action_spot_dodges,
      sum(action_wavedashes) as action_wavedashes,
      sum(action_wavelands) as action_wavelands,
      sum(action_dash_dances) as action_dash_dances,
      sum(action_ledge_grabs) as action_ledge_grabs,
      sum(action_crouch_cancels) as action_crouch_cancels,
      sum(action_grabs) as action_grabs
    from execution_user, params
    group by lookback_days, character_id, params.min_players, params.min_games
    having sum(unique_games) >= params.min_games
       and public.community_count_players(jsonb_agg(player_keys)) >= params.min_players
  ),
  character_user as (
    select
      r.user_id,
      coalesce(j->'playerKeys', '[]'::jsonb) as player_keys,
      coalesce((j->>'uniqueGames')::bigint, 0) as unique_games,
      (j->>'lookbackDays')::int as lookback_days,
      (j->>'characterId')::int as character_id,
      (j->>'games')::bigint as games,
      (j->>'wins')::bigint as wins,
      (j->>'decided')::bigint as decided
    from public.community_user_rollups r
    cross join lateral jsonb_array_elements(coalesce(r.payload->'characters', '[]'::jsonb)) j
  ),
  character_totals as (
    select lookback_days, character_id, sum(games)::bigint as games
    from character_user
    group by lookback_days, character_id
  ),
  move_user as (
    select
      r.user_id,
      coalesce(j->'playerKeys', '[]'::jsonb) as player_keys,
      coalesce((j->>'uniqueGames')::bigint, 0) as unique_games,
      (j->>'lookbackDays')::int as lookback_days,
      (j->>'characterId')::int as character_id,
      j->>'moveKey' as move_key,
      (j->>'moveGames')::bigint as move_games,
      (j->>'attempts')::numeric as attempts,
      (j->>'attemptGames')::bigint as attempt_games,
      (j->>'landed')::numeric as landed,
      (j->>'damage')::numeric as damage,
      (j->>'kills')::numeric as kills,
      (j->>'killPctSum')::numeric as kill_pct_sum,
      (j->>'openings')::numeric as openings,
      (j->>'openingDamage')::numeric as opening_damage,
      (j->>'lCancelSuccess')::numeric as l_cancel_success,
      (j->>'lCancelFail')::numeric as l_cancel_fail
    from public.community_user_rollups r
    cross join lateral jsonb_array_elements(coalesce(r.payload->'moves', '[]'::jsonb)) j
  ),
  move_rollup as (
    select
      m.lookback_days,
      m.character_id,
      m.move_key,
      c.games as character_games,
      count(*)::int as contributors,
      public.community_count_players(jsonb_agg(m.player_keys)) as players,
      sum(m.unique_games)::bigint as unique_games,
      sum(m.attempts) as attempts,
      sum(m.attempt_games)::bigint as attempt_games,
      sum(m.landed) as landed,
      sum(m.damage) as damage,
      sum(m.kills) as kills,
      sum(m.kill_pct_sum) as kill_pct_sum,
      sum(m.openings) as openings,
      sum(m.opening_damage) as opening_damage,
      sum(m.l_cancel_success) as l_cancel_success,
      sum(m.l_cancel_fail) as l_cancel_fail,
      sum(m.move_games)::bigint as move_games
    from move_user m
    join character_totals c
      on c.character_id = m.character_id
     and c.lookback_days is not distinct from m.lookback_days
    cross join params
    group by m.lookback_days, m.character_id, m.move_key, c.games, params.min_players, params.min_games
    having public.community_count_players(jsonb_agg(m.player_keys)) >= params.min_players
       and sum(m.unique_games) >= params.min_games
       and c.games >= params.min_games
  ),
  month_user as (
    select
      r.user_id,
      coalesce(j->'playerKeys', '[]'::jsonb) as player_keys,
      coalesce((j->>'uniqueGames')::bigint, 0) as unique_games,
      (j->>'month')::date as month,
      (j->>'games')::bigint as games,
      (j->>'durationSeconds')::numeric as duration_seconds,
      (j->>'ranked')::bigint as ranked,
      (j->>'unranked')::bigint as unranked,
      (j->>'direct')::bigint as direct,
      (j->>'offline')::bigint as offline
    from public.community_user_rollups r
    cross join lateral jsonb_array_elements(coalesce(r.payload->'months', '[]'::jsonb)) j
  ),
  month_rollup as (
    select
      month,
      sum(games)::bigint as player_games,
      count(*)::int as contributors,
      public.community_count_players(jsonb_agg(player_keys)) as players,
      sum(unique_games)::bigint as unique_games,
      sum(duration_seconds) / nullif(sum(games), 0) as average_duration_seconds,
      sum(ranked)::bigint as ranked,
      sum(unranked)::bigint as unranked,
      sum(direct)::bigint as direct,
      sum(offline)::bigint as offline
    from month_user, params
    group by month, params.min_players, params.min_games
    having sum(unique_games) >= params.min_games
       and public.community_count_players(jsonb_agg(player_keys)) >= params.min_players
  ),
  character_rollup as (
    select
      character_id,
      sum(games)::bigint as player_games,
      count(*)::int as contributors,
      public.community_count_players(jsonb_agg(player_keys)) as players,
      sum(unique_games)::bigint as unique_games,
      sum(wins)::bigint as wins,
      sum(decided)::bigint as decided
    from character_user, params
    where lookback_days is null
    group by character_id, params.min_players, params.min_games
    having sum(unique_games) >= params.min_games
       and public.community_count_players(jsonb_agg(player_keys)) >= params.min_players
  ),
  stage_user as (
    select
      r.user_id,
      coalesce(j->'playerKeys', '[]'::jsonb) as player_keys,
      coalesce((j->>'uniqueGames')::bigint, 0) as unique_games,
      (j->>'stageId')::int as stage_id,
      (j->>'games')::bigint as games,
      (j->>'durationSeconds')::numeric as duration_seconds
    from public.community_user_rollups r
    cross join lateral jsonb_array_elements(coalesce(r.payload->'stages', '[]'::jsonb)) j
  ),
  stage_rollup as (
    select
      stage_id,
      sum(games)::bigint as player_games,
      count(*)::int as contributors,
      public.community_count_players(jsonb_agg(player_keys)) as players,
      sum(unique_games)::bigint as unique_games,
      sum(duration_seconds) / nullif(sum(games), 0) as average_duration_seconds
    from stage_user, params
    group by stage_id, params.min_players, params.min_games
    having sum(unique_games) >= params.min_games
       and public.community_count_players(jsonb_agg(player_keys)) >= params.min_players
  ),
  assembled as (
    select jsonb_build_object(
      'thresholdVersion', 'unique-players-v2',
      'matchups', coalesce((select jsonb_agg(jsonb_build_object(
        'lookbackDays', lookback_days,
        'characterId', character_id, 'opponentCharacterId', opponent_character_id,
        'stageId', stage_id, 'gameType', game_type,
        'games', public.pub_bucket(games, 25),
        'contributors', greatest(1, public.pub_bucket(contributors, 5)),
        'players', public.pub_bucket(players, 5),
        'uniqueGames', public.pub_bucket(unique_games, 25),
        'wins', public.pub_bucket(wins, 25),
        'winRate', round(wins::numeric / games, 3)
      ) order by games desc) from matchup_rollup), '[]'::jsonb),
      'characterStages', coalesce((select jsonb_agg(jsonb_build_object(
        'lookbackDays', lookback_days, 'characterId', character_id,
        'stageId', stage_id, 'gameType', game_type,
        'games', public.pub_bucket(games, 25),
        'contributors', greatest(1, public.pub_bucket(contributors, 5)),
        'players', public.pub_bucket(players, 5),
        'uniqueGames', public.pub_bucket(unique_games, 25),
        'wins', public.pub_bucket(wins, 25),
        'winRate', round(wins::numeric / games, 3)
      ) order by games desc) from character_stage_rollup), '[]'::jsonb),
      'benchmarks', coalesce((select jsonb_agg(jsonb_build_object(
        'characterId', character_id, 'games', public.pub_bucket(games, 25),
        'contributors', greatest(1, public.pub_bucket(contributors, 5)),
        'players', public.pub_bucket(players, 5),
        'uniqueGames', public.pub_bucket(unique_games, 25),
        'lCancel', case when l_cancel_q is null then null else jsonb_build_object('p25', round(l_cancel_q[1], 1), 'p50', round(l_cancel_q[2], 1), 'p75', round(l_cancel_q[3], 1)) end,
        'openingsPerKill', case when opk_q is null then null else jsonb_build_object('p25', round(opk_q[1], 1), 'p50', round(opk_q[2], 1), 'p75', round(opk_q[3], 1)) end,
        'damagePerOpening', case when dpo_q is null then null else jsonb_build_object('p25', round(dpo_q[1], 1), 'p50', round(dpo_q[2], 1), 'p75', round(dpo_q[3], 1)) end,
        'inputsPerMinute', case when ipm_q is null then null else jsonb_build_object('p25', round(ipm_q[1], 1), 'p50', round(ipm_q[2], 1), 'p75', round(ipm_q[3], 1)) end
      ) order by character_id) from benchmark_rollup), '[]'::jsonb),
      'execution', coalesce((select jsonb_agg(jsonb_build_object(
        'lookbackDays', lookback_days,
        'characterId', character_id, 'games', public.pub_bucket(games, 25),
        'contributors', greatest(1, public.pub_bucket(contributors, 5)),
        'players', public.pub_bucket(players, 5),
        'uniqueGames', public.pub_bucket(unique_games, 25),
        'lCancelSuccess', round(l_cancel_success, 1),
        'groundTechSuccess', round(ground_tech_success, 1),
        'groundTechInPlace', round(ground_tech_in_place, 1),
        'groundTechIn', round(ground_tech_in, 1),
        'groundTechAway', round(ground_tech_away, 1),
        'techInPlaceCount', tech_in_place_count,
        'techInCount', tech_in_count,
        'techAwayCount', tech_away_count,
        'actionCounts', jsonb_build_object(
          'rolls', action_rolls,
          'airDodges', action_air_dodges,
          'spotDodges', action_spot_dodges,
          'wavedashes', action_wavedashes,
          'wavelands', action_wavelands,
          'dashDances', action_dash_dances,
          'ledgeGrabs', action_ledge_grabs,
          'crouchCancels', action_crouch_cancels,
          'grabs', action_grabs
        )
      ) order by character_id) from execution_rollup), '[]'::jsonb),
      'moves', coalesce((select jsonb_agg(jsonb_build_object(
        'lookbackDays', lookback_days,
        'characterId', character_id, 'moveKey', move_key,
        'characterGames', public.pub_bucket(character_games, 25),
        'contributors', greatest(1, public.pub_bucket(contributors, 5)),
        'players', public.pub_bucket(players, 5),
        'uniqueGames', public.pub_bucket(unique_games, 25),
        'attempts', attempts, 'attemptGames', public.pub_bucket(attempt_games, 25),
        'landed', landed, 'damage', damage, 'kills', kills,
        'killPctSum', kill_pct_sum, 'openings', openings,
        'openingDamage', opening_damage, 'lCancelSuccess', l_cancel_success,
        'lCancelFail', l_cancel_fail
      ) order by character_id, damage desc) from move_rollup), '[]'::jsonb),
      'months', coalesce((select jsonb_agg(jsonb_build_object(
        'month', month, 'playerGames', public.pub_bucket(player_games, 25),
        'contributors', greatest(1, public.pub_bucket(contributors, 5)),
        'players', public.pub_bucket(players, 5),
        'uniqueGames', public.pub_bucket(unique_games, 25),
        'averageDurationSeconds', round(average_duration_seconds, 0),
        'ranked', public.pub_bucket(ranked, 25),
        'unranked', public.pub_bucket(unranked, 25),
        'direct', public.pub_bucket(direct, 25),
        'offline', public.pub_bucket(offline, 25)
      ) order by month) from month_rollup), '[]'::jsonb),
      'characters', coalesce((select jsonb_agg(jsonb_build_object(
        'characterId', character_id, 'playerGames', public.pub_bucket(player_games, 25),
        'contributors', greatest(1, public.pub_bucket(contributors, 5)),
        'players', public.pub_bucket(players, 5),
        'uniqueGames', public.pub_bucket(unique_games, 25),
        'wins', public.pub_bucket(wins, 25),
        'decided', public.pub_bucket(decided, 25),
        'winRate', case when decided > 0 then round(wins::numeric / decided, 3) else null end
      ) order by player_games desc) from character_rollup), '[]'::jsonb),
      'stages', coalesce((select jsonb_agg(jsonb_build_object(
        'stageId', stage_id, 'playerGames', public.pub_bucket(player_games, 25),
        'contributors', greatest(1, public.pub_bucket(contributors, 5)),
        'players', public.pub_bucket(players, 5),
        'uniqueGames', public.pub_bucket(unique_games, 25),
        'averageDurationSeconds', round(average_duration_seconds, 0)
      ) order by player_games desc) from stage_rollup), '[]'::jsonb)
    ) as payload
  )
  insert into public.community_snapshot (
    snapshot_id, refreshed_at, contributor_count, player_game_count,
    min_contributors, min_players, min_games, payload
  )
  select 'current', now(), active.contributors, active.player_games,
         params.min_contributors, params.min_players, params.min_games, assembled.payload
  from active, params, assembled
  on conflict (snapshot_id) do update set
    refreshed_at = excluded.refreshed_at,
    contributor_count = excluded.contributor_count,
    player_game_count = excluded.player_game_count,
    min_contributors = excluded.min_contributors,
    min_players = excluded.min_players,
    min_games = excluded.min_games,
    payload = excluded.payload;
end;
$$;

revoke all on function public.refresh_community_snapshot() from public, anon, authenticated;
grant execute on function public.refresh_community_snapshot() to service_role;

-- Seed the cache backfill. Re-running this file deliberately requeues every
-- user so changes to the private rollup shape (such as lookback cohorts) are
-- populated before the next public snapshot is assembled.
insert into public.community_dirty_users (user_id, queued_at)
select user_id, now() from public.community_consent
on conflict (user_id) do update set queued_at = excluded.queued_at;

commit;

-- First run / manual refresh:
--   set statement_timeout = '10min';
--   select public.refresh_community_snapshot();
--
-- In production, schedule both statements as one command every 15 minutes with
-- Supabase Cron. The SET must precede the SELECT in the scheduled command: a
-- function-level SET happens after Postgres has already armed the caller's
-- statement timer, so it cannot extend the refresh's two-minute default.
-- Unchanged runs return immediately. A game/code/consent write queues only that
-- user; switching consent off removes that user's private rollup on the next run.
