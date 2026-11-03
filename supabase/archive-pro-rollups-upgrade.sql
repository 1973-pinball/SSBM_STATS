-- Add pooled Pro rollups without changing published rows or publication rules.
-- Apply before loading the first export containing scope='pro'.
begin;

alter table public.archive_rollups
  drop constraint if exists archive_rollups_scope_check;
alter table public.archive_rollups
  add constraint archive_rollups_scope_check
  check (scope in ('community', 'series', 'tournament', 'player', 'pro', 'set'));

alter table public.archive_rollups
  drop constraint if exists archive_rollups_scope_shape_check;
alter table public.archive_rollups
  add constraint archive_rollups_scope_shape_check check (
    (scope = 'community' and series_id is null and tournament_id is null and set_id is null and player_id is null)
    or (scope = 'pro' and population = 'conservative' and series_id is null and tournament_id is null and set_id is null and player_id is null and identified_player_count is not null and identified_player_count > 0)
    or (scope = 'series' and series_id is not null and tournament_id is null and set_id is null and player_id is null)
    or (scope = 'tournament' and tournament_id is not null and set_id is null and player_id is null)
    or (scope = 'player' and player_id is not null and set_id is null)
    or (scope = 'set' and set_id is not null)
  );

-- This capability appears only when the containing migration commits.
create or replace function public.archive_supports_pooled_pro_rollups()
returns boolean
language sql
stable
security invoker
set search_path = public
as $$ select true; $$;
revoke all on function public.archive_supports_pooled_pro_rollups() from public, anon, authenticated;
grant execute on function public.archive_supports_pooled_pro_rollups() to service_role;

commit;
