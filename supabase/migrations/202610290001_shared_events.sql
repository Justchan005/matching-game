-- Run once in the Supabase SQL editor (or apply with Supabase migrations).
-- Host accounts use Supabase Auth. Players need only the shared event link.
begin;

create schema if not exists game_private;
revoke all on schema game_private from public, anon, authenticated;

create table game_private.events (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  owner_id uuid not null,
  title text not null check (char_length(title) between 1 and 80),
  scenario_title text not null,
  description text not null,
  category text not null,
  explanation text not null,
  active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default (clock_timestamp() + interval '7 days')
);

create table game_private.steps (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references game_private.events(id) on delete cascade,
  position smallint not null check (position between 1 and 12),
  text text not null check (char_length(text) between 1 and 160),
  unique (event_id, position)
);

create table game_private.rounds (
  token uuid primary key default gen_random_uuid(),
  event_id uuid not null references game_private.events(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 30),
  started_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  result jsonb,
  check ((completed_at is null) = (result is null))
);

create index rounds_event_id_idx on game_private.rounds (event_id);
create index events_owner_created_idx on game_private.events (owner_id, created_at);

alter table game_private.events enable row level security;
alter table game_private.steps enable row level security;
alter table game_private.rounds enable row level security;
revoke all on all tables in schema game_private from public, anon, authenticated;

create function public.get_event(p_code text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_event game_private.events%rowtype;
  v_count integer;
begin
  select * into v_event from game_private.events where code = lower(btrim(p_code));
  if not found then
    raise exception 'Event not found. Check the event link or code.' using errcode = 'P0002';
  end if;
  select count(*) into v_count from game_private.steps where event_id = v_event.id;
  return jsonb_build_object(
    'code', v_event.code, 'title', v_event.title,
    'active', v_event.active and v_event.expires_at > clock_timestamp(),
    'expires_at', v_event.expires_at,
    'scenario', jsonb_build_object('title', v_event.scenario_title,
      'description', v_event.description, 'category', v_event.category, 'step_count', v_count)
  );
end;
$$;

create function public.create_event(p_title text, p_scenario jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_event game_private.events%rowtype;
  v_steps text[];
  v_title text := btrim(p_title, E' \t\n\r\f');
  v_scenario_title text := btrim(p_scenario->>'title', E' \t\n\r\f');
  v_description text := btrim(p_scenario->>'description', E' \t\n\r\f');
  v_category text := coalesce(nullif(btrim(p_scenario->>'category', E' \t\n\r\f'), ''), 'YOUR EVENT');
  v_explanation text := coalesce(btrim(p_scenario->>'explanation', E' \t\n\r\f'), 'This is the intended sequence entered by your event host.');
begin
  if v_owner is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) then
    raise exception 'Sign in with a host account to create an event.' using errcode = '42501';
  end if;
  if v_title is null or char_length(v_title) not between 1 and 80 then
    raise exception 'Enter an event title between 1 and 80 characters.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_scenario) is distinct from 'object'
    or jsonb_typeof(p_scenario->'title') is distinct from 'string'
    or v_scenario_title is null or char_length(v_scenario_title) not between 1 and 80
    or jsonb_typeof(p_scenario->'description') is distinct from 'string'
    or v_description is null or char_length(v_description) not between 1 and 500
    or (p_scenario ? 'category' and jsonb_typeof(p_scenario->'category') <> 'string')
    or (p_scenario ? 'explanation' and jsonb_typeof(p_scenario->'explanation') <> 'string')
    or char_length(v_category) > 80 or char_length(v_explanation) > 1000 then
    raise exception 'Enter a valid scenario title and description.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_scenario->'steps') is distinct from 'array' then
    raise exception 'Add between 3 and 12 steps in the intended order.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_scenario->'steps') not between 3 and 12
    or exists (select 1 from jsonb_array_elements(p_scenario->'steps') as entry(value)
      where jsonb_typeof(value) <> 'string') then
    raise exception 'Add between 3 and 12 text steps in the intended order.' using errcode = '22023';
  end if;
  select array_agg(btrim(value, E' \t\n\r\f') order by ordinal) into v_steps
    from jsonb_array_elements_text(p_scenario->'steps') with ordinality as entry(value, ordinal);
  if exists (select 1 from unnest(v_steps) as entry(value) where char_length(value) not between 1 and 160)
    or (select count(distinct lower(value)) from unnest(v_steps) as entry(value)) <> cardinality(v_steps) then
    raise exception 'Use distinct, nonblank steps of up to 160 characters.' using errcode = '22023';
  end if;
  -- Serialize event creation per host so concurrent requests cannot bypass the limit.
  perform pg_advisory_xact_lock(hashtextextended(v_owner::text, 0));
  if (select count(*) from game_private.events where owner_id = v_owner
    and created_at > clock_timestamp() - interval '24 hours') >= 50 then
    raise exception 'This host has reached the limit of 50 events per day.' using errcode = '54000';
  end if;
  insert into game_private.events (code, owner_id, title, scenario_title, description, category, explanation)
    values (substr(replace(gen_random_uuid()::text, '-', ''), 1, 12), v_owner,
      v_title, v_scenario_title, v_description, v_category, v_explanation)
    returning * into v_event;
  insert into game_private.steps (event_id, position, text)
    select v_event.id, ordinal::smallint, value
    from unnest(v_steps) with ordinality as entry(value, ordinal);
  return public.get_event(v_event.code);
end;
$$;

create function public.start_round(p_code text, p_name text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_event game_private.events%rowtype;
  v_round game_private.rounds%rowtype;
  v_name text := btrim(p_name, E' \t\n\r\f');
  v_order uuid[];
  v_correct uuid[];
  v_steps jsonb;
  v_first uuid;
begin
  if v_name is null or char_length(v_name) not between 1 and 30 then
    raise exception 'Enter a player or team name between 1 and 30 characters.' using errcode = '22023';
  end if;
  -- The event lock also makes the round cap and closing an event atomic.
  select * into v_event from game_private.events where code = lower(btrim(p_code)) for update;
  if not found then
    raise exception 'Event not found. Check the event link or code.' using errcode = 'P0002';
  end if;
  if not v_event.active or v_event.expires_at <= clock_timestamp() then
    raise exception 'This event is closed. Ask the host for a new event link.' using errcode = '55000';
  end if;
  if (select count(*) from game_private.rounds where event_id = v_event.id) >= 5000 then
    raise exception 'This event has reached its limit of 5000 rounds.' using errcode = '54000';
  end if;
  select array_agg(id order by random()), array_agg(id order by position)
    into v_order, v_correct from game_private.steps where event_id = v_event.id;
  if v_order = v_correct then
    v_first := v_order[1]; v_order[1] := v_order[2]; v_order[2] := v_first;
  end if;
  select jsonb_agg(jsonb_build_object('id', step.id, 'text', step.text) order by chosen.ordinal)
    into v_steps from unnest(v_order) with ordinality as chosen(id, ordinal)
    join game_private.steps step on step.id = chosen.id;
  insert into game_private.rounds (event_id, name) values (v_event.id, v_name) returning * into v_round;
  return jsonb_build_object('token', v_round.token, 'started_at', v_round.started_at, 'steps', v_steps);
end;
$$;

create function public.submit_round(p_token uuid, p_order uuid[])
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_round game_private.rounds%rowtype;
  v_event game_private.events%rowtype;
  v_ids uuid[];
  v_correct_ids uuid[];
  v_texts jsonb;
  v_correct integer;
  v_total integer;
  v_seconds integer;
  v_result jsonb;
  v_completed timestamptz;
begin
  select * into v_round from game_private.rounds where token = p_token for update;
  if not found then
    raise exception 'Round not found. Start a new round.' using errcode = 'P0002';
  end if;
  -- A lost HTTP response can be retried without submitting a second score or
  -- changing the first answer, even when the retried payload is different.
  if v_round.result is not null then return v_round.result; end if;
  select * into v_event from game_private.events where id = v_round.event_id;
  if v_event.expires_at <= clock_timestamp() then
    raise exception 'This event has expired. Ask the host for a new event link.' using errcode = '55000';
  end if;
  select array_agg(id order by position), jsonb_agg(text order by position)
    into v_ids, v_texts from game_private.steps where event_id = v_round.event_id;
  v_total := cardinality(v_ids);
  if p_order is null or array_ndims(p_order) <> 1 or cardinality(p_order) <> v_total
    or (select count(distinct id) from unnest(p_order) as item(id)) <> v_total
    or not (p_order @> v_ids and v_ids @> p_order) then
    raise exception 'Submit every step exactly once for this round.' using errcode = '22023';
  end if;
  select count(*), coalesce(array_agg(chosen.id order by chosen.ordinal), array[]::uuid[])
    into v_correct, v_correct_ids from unnest(p_order) with ordinality as chosen(id, ordinal)
    join game_private.steps step on step.id = chosen.id
    where step.event_id = v_round.event_id and step.position = chosen.ordinal;
  v_completed := clock_timestamp();
  v_seconds := greatest(0, floor(extract(epoch from (v_completed - v_round.started_at)))::integer);
  v_result := jsonb_build_object('correct', v_correct, 'total', v_total,
    'score', round(100.0 * v_correct / v_total)::integer, 'seconds', v_seconds,
    'correct_ids', to_jsonb(v_correct_ids), 'steps', v_texts, 'explanation', v_event.explanation);
  update game_private.rounds set completed_at = v_completed, result = v_result where token = p_token;
  return v_result;
end;
$$;

create function public.get_leaderboard(p_code text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_event_id uuid;
  v_results jsonb;
begin
  select id into v_event_id from game_private.events where code = lower(btrim(p_code));
  if not found then
    raise exception 'Event not found. Check the event link or code.' using errcode = 'P0002';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('name', ranked.name, 'score', ranked.result->'score',
    'seconds', ranked.result->'seconds') order by ranked.rank), '[]'::jsonb)
    into v_results from (
      select name, result, row_number() over (order by (result->>'score')::integer desc,
        (result->>'seconds')::integer asc, completed_at asc, token asc) as rank
      from game_private.rounds where event_id = v_event_id and completed_at is not null
      order by (result->>'score')::integer desc, (result->>'seconds')::integer asc, completed_at asc, token asc
      limit 20
    ) ranked;
  return v_results;
end;
$$;

create function public.close_event(p_code text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_code text;
begin
  if v_owner is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) then
    raise exception 'Sign in with the event host account.' using errcode = '42501';
  end if;
  update game_private.events set active = false
    where code = lower(btrim(p_code)) and owner_id = v_owner returning code into v_code;
  if not found then
    raise exception 'Only the host can close this event.' using errcode = '42501';
  end if;
  return public.get_event(v_code);
end;
$$;

revoke all on function public.create_event(text, jsonb) from public, anon, authenticated;
revoke all on function public.get_event(text) from public, anon, authenticated;
revoke all on function public.start_round(text, text) from public, anon, authenticated;
revoke all on function public.submit_round(uuid, uuid[]) from public, anon, authenticated;
revoke all on function public.get_leaderboard(text) from public, anon, authenticated;
revoke all on function public.close_event(text) from public, anon, authenticated;
grant execute on function public.create_event(text, jsonb) to authenticated;
grant execute on function public.close_event(text) to authenticated;
grant execute on function public.get_event(text) to anon, authenticated;
grant execute on function public.start_round(text, text) to anon, authenticated;
grant execute on function public.submit_round(uuid, uuid[]) to anon, authenticated;
grant execute on function public.get_leaderboard(text) to anon, authenticated;

commit;
