import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// Integration tests run the actual migration in an isolated PostgreSQL server.
// No Supabase project or credentials are used. The database has no exposed port.
const image = 'postgres:17-alpine@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b';
const container = `flow-state-db-test-${randomUUID()}`;
const owner = '11111111-1111-4111-8111-111111111111';
const otherOwner = '22222222-2222-4222-8222-222222222222';
const scenario = {
  title: 'The road to a diagnosis', description: 'Put the diagnosis journey in order.',
  category: 'PATIENT JOURNEY', explanation: 'Follow the intended sequence.',
  steps: ['Book appointment', 'Check in', 'Wait', 'See doctor', 'Receive referral',
    'Book X-ray', 'Attend X-ray', 'Take X-ray', 'Review results'],
};

function docker(args, options = {}) {
  return execFileSync('docker', args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024, ...options });
}

function sql(input) {
  return docker(['exec', '-i', container, 'psql', '--no-psqlrc', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-U', 'postgres'], {
    input, stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function literal(value) { return `'${String(value).replaceAll("'", "''")}'`; }
function call(name, args = [], role = 'anon', user = '') {
  const claims = JSON.stringify({ sub: user, is_anonymous: false });
  const result = sql(`set request.jwt.claim.sub = ${literal(user)};
    set request.jwt.claims = ${literal(claims)};
    set role ${role}; select public.${name}(${args.join(',')});`);
  return JSON.parse(result);
}
function createEvent(data = scenario, user = owner) {
  return call('create_event', [literal('Team event'), `${literal(JSON.stringify(data))}::jsonb`], 'authenticated', user);
}
function start(event, name = 'Team A') { return call('start_round', [literal(event.code), literal(name)]); }
function canonical(round, data = scenario) {
  return data.steps.map((text) => round.steps.find((step) => step.text === text).id);
}
function submit(round, ids) {
  return call('submit_round', [`${literal(round.token)}::uuid`, `array[${ids.map(literal).join(',')}]::uuid[]`]);
}
function fails(operation, message) {
  assert.throws(operation, (error) => String(error.stderr || error.message).includes(message));
}

before(async () => {
  docker(['run', '--detach', '--rm', '--name', container, '--network', 'none',
    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', image]);
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    // The image's temporary initialization server exposes a Unix socket only.
    // TCP confirms that initialization finished and the final server is serving.
    try {
      docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'], { stdio: 'pipe' });
      assert.equal(sql('select 1;'), '1');
      ready = true;
      break;
    }
    catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  assert.ok(ready, 'PostgreSQL becomes ready');
  sql(`create role anon nologin; create role authenticated nologin;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as
      $$ select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on all functions in schema auth to anon, authenticated;`);
  sql(readFileSync(new URL('../migrations/202610290001_shared_events.sql', import.meta.url), 'utf8'));
});

after(() => { try { docker(['rm', '--force', container], { stdio: 'pipe' }); } catch { /* already removed */ } });

test('host creates metadata-only event; anonymous users cannot create or inspect tables', () => {
  const event = createEvent();
  assert.match(event.code, /^[a-f0-9]{12}$/);
  assert.equal(event.active, true);
  assert.equal(event.scenario.step_count, 9);
  assert.equal('steps' in event.scenario, false);
  assert.deepEqual(call('get_event', [literal(event.code.toUpperCase())]), event);
  fails(() => call('create_event', [literal('Unauthorized'), `${literal(JSON.stringify(scenario))}::jsonb`]), 'permission denied');
  for (const role of ['anon', 'authenticated']) {
    for (const table of ['events', 'steps', 'rounds']) {
      fails(() => sql(`set role ${role}; select * from game_private.${table};`), 'permission denied');
    }
  }
  assert.equal(sql(`select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='game_private' and c.relkind='r' and c.relrowsecurity;`), '3');
});

test('Supabase anonymous-auth accounts and missing identities cannot host', () => {
  const payload = `${literal('Event')}, ${literal(JSON.stringify(scenario))}::jsonb`;
  fails(() => sql(`set request.jwt.claim.sub=${literal(owner)};
    set request.jwt.claims='{"is_anonymous":true}'; set role authenticated;
    select public.create_event(${payload});`), 'Sign in with a host account');
  fails(() => call('create_event', [literal('Event'), `${literal(JSON.stringify(scenario))}::jsonb`], 'authenticated'), 'Sign in with a host account');
});

test('start returns random opaque step IDs and an unsolved permutation', () => {
  const event = createEvent();
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const round = start(event);
    assert.match(round.token, /^[a-f0-9-]{36}$/);
    assert.ok(Number.isFinite(Date.parse(round.started_at)));
    assert.equal(new Set(round.steps.map((step) => step.id)).size, 9);
    assert.deepEqual([...round.steps.map((step) => step.text)].sort(), [...scenario.steps].sort());
    assert.notDeepEqual(round.steps.map((step) => step.text), scenario.steps);
    assert.ok(round.steps.every((step) => Object.keys(step).sort().join(',') === 'id,text'));
  }
});

test('server computes scores and elapsed time; retry cannot replace the first answer', () => {
  const event = createEvent();
  const round = start(event, 'Team One');
  sql(`update game_private.rounds set started_at=clock_timestamp()-interval '42 seconds' where token=${literal(round.token)};`);
  const ids = canonical(round);
  const partial = [...ids];
  [partial[0], partial[1]] = [partial[1], partial[0]];
  const result = submit(round, partial);
  assert.equal(result.correct, 7);
  assert.equal(result.total, 9);
  assert.equal(result.score, 78);
  assert.ok(result.seconds >= 42 && result.seconds < 47);
  assert.deepEqual(result.steps, scenario.steps);
  assert.deepEqual(result.correct_ids, ids.slice(2));
  assert.deepEqual(submit(round, ids), result, 'retry cannot change a submitted score');
  const leaderboard = call('get_leaderboard', [literal(event.code)]);
  assert.equal(leaderboard.length, 1);
  assert.equal(leaderboard[0].score, 78);
});

test('separate players share an event leaderboard with score and server-time ordering', () => {
  const event = createEvent();
  const slow = start(event, 'Slow team');
  const fast = start(event, 'Fast team');
  const partial = start(event, 'Learning team');
  sql(`update game_private.rounds set started_at=clock_timestamp()-interval '50 seconds' where token=${literal(slow.token)};
    update game_private.rounds set started_at=clock_timestamp()-interval '10 seconds' where token=${literal(fast.token)};`);
  submit(slow, canonical(slow));
  submit(fast, canonical(fast));
  submit(partial, canonical(partial).reverse());
  assert.deepEqual(call('get_leaderboard', [literal(event.code)]).map((row) => row.name),
    ['Fast team', 'Slow team', 'Learning team']);
  const other = createEvent();
  assert.deepEqual(call('get_leaderboard', [literal(other.code)]), []);
});

test('duplicate, missing, null, malformed, and foreign-event steps cannot submit a result', () => {
  const event = createEvent();
  const round = start(event);
  const ids = canonical(round);
  fails(() => submit(round, ids.slice(1)), 'Submit every step exactly once');
  fails(() => submit(round, Array(9).fill(ids[0])), 'Submit every step exactly once');
  fails(() => submit(round, canonical(start(createEvent()))), 'Submit every step exactly once');
  fails(() => call('submit_round', [`${literal(round.token)}::uuid`, 'null']), 'Submit every step exactly once');
  fails(() => call('submit_round', [`${literal(round.token)}::uuid`, `'{{${ids.slice(0, 3).join(',')}},{${ids.slice(3, 6).join(',')}},{${ids.slice(6).join(',')}}}'::uuid[]`]), 'Submit every step exactly once');
  fails(() => call('submit_round', [`${literal(randomUUID())}::uuid`, `array[${ids.map(literal).join(',')}]::uuid[]`]), 'Round not found');
  assert.deepEqual(call('get_leaderboard', [literal(event.code)]), []);
  assert.equal(submit(round, ids).score, 100);
});

test('only the owner can close; closed events stop new rounds but accept started rounds', () => {
  const event = createEvent();
  const round = start(event);
  fails(() => call('close_event', [literal(event.code)], 'authenticated', otherOwner), 'Only the host can close');
  fails(() => call('close_event', [literal(event.code)]), 'permission denied');
  const closed = call('close_event', [literal(event.code)], 'authenticated', owner);
  assert.equal(closed.active, false);
  assert.equal(call('get_event', [literal(event.code)]).active, false);
  fails(() => start(event), 'This event is closed');
  assert.equal(submit(round, canonical(round)).score, 100);
});

test('expired events reject new rounds and pending submissions', () => {
  const event = createEvent();
  const round = start(event);
  sql(`update game_private.events set expires_at=clock_timestamp()-interval '1 second' where code=${literal(event.code)};`);
  assert.equal(call('get_event', [literal(event.code)]).active, false);
  fails(() => start(event), 'This event is closed');
  fails(() => submit(round, canonical(round)), 'This event has expired');
});

test('scenario and player validation enforces supported bounds', () => {
  for (const steps of [[], ['One', 'Two'], ['One', 'One', 'Three'], ['One', ' one ', 'Three'],
    ['One', '', 'Three'], ['One', '\t\n', 'Three'], ['One', '\nOne\n', 'Three'],
    ['One', 2, 'Three'], Array.from({ length: 13 }, (_, i) => `Step ${i}`),
    ['One', 'Two', 'x'.repeat(161)]]) {
    fails(() => createEvent({ ...scenario, steps }), 'ERROR:');
  }
  const event = createEvent({ ...scenario, steps: Array.from({ length: 12 }, (_, i) => `Step ${i + 1}`) });
  assert.equal(event.scenario.step_count, 12);
  for (const name of ['', '   ', '\t\r\n', 'x'.repeat(31)]) fails(() => start(event, name), 'Enter a player or team name');
  fails(() => call('get_event', [literal('missing')]), 'Event not found');
});

test('leaderboard caps at twenty rows and public RPCs never expose round tokens', () => {
  const event = createEvent();
  for (let index = 0; index < 21; index += 1) {
    const round = start(event, `Team ${index + 1}`);
    submit(round, canonical(round));
  }
  const rows = call('get_leaderboard', [literal(event.code)]);
  assert.equal(rows.length, 20);
  assert.ok(rows.every((row) => Object.keys(row).sort().join(',') === 'name,score,seconds'));
});

test('per-event and per-host limits reject excess creation', () => {
  const event = createEvent();
  sql(`insert into game_private.rounds(event_id,name)
    select e.id,'Load test' from game_private.events e cross join generate_series(1,5000)
    where e.code=${literal(event.code)};`);
  fails(() => start(event), 'This event has reached its limit of 5000 rounds');
  const limitOwner = '33333333-3333-4333-8333-333333333333';
  sql(`insert into game_private.events(code,owner_id,title,scenario_title,description,category,explanation)
    select 'limit-test-'||n,${literal(limitOwner)}::uuid,'Title','Scenario','Description','Category','Explanation'
    from generate_series(1,50) as n;`);
  fails(() => createEvent(scenario, limitOwner), 'This host has reached the limit of 50 events per day');
});
