import test from 'node:test';
import assert from 'node:assert/strict';
import { createOnlineClient, validateOnlineConfig, REQUEST_TIMEOUT_MS } from './online-api.mjs';

const config = { url: 'https://example.supabase.co', key: 'sb_publishable_test_public_key' };
const jwt = (role) => `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.test_signature`;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('configuration accepts browser keys and rejects secret keys or unsafe project URLs before sending', () => {
  assert.equal(validateOnlineConfig(config).valid, true);
  assert.equal(validateOnlineConfig({ ...config, url: `${config.url}/` }).valid, true);
  assert.equal(validateOnlineConfig({ ...config, key: jwt('anon') }).valid, true);
  assert.equal(validateOnlineConfig({ ...config, url: 'http://localhost:54321' }).valid, true);
  assert.equal(validateOnlineConfig({ ...config, url: 'http://127.0.0.1:54321' }).valid, true);
  for (const key of ['sb_secret_never_expose', jwt('service_role'), 'not-a-key', 'bad.payload.signature', '']) {
    assert.equal(validateOnlineConfig({ ...config, key }).valid, false);
    assert.throws(() => createOnlineClient({ ...config, key }, () => assert.fail('Must not send rejected keys')), { code: 'invalid_config' });
  }
  for (const url of ['http://example.supabase.co', 'https://user:password@example.supabase.co', 'https://example.supabase.co/path', 'https://example.supabase.co?key=secret', 'https://example.supabase.co#fragment', 'file:///tmp/game']) {
    assert.equal(validateOnlineConfig({ ...config, url }).valid, false);
  }
});

test('player RPCs send exact parameters and only the public apikey for publishable keys', async () => {
  const calls = [];
  const client = createOnlineClient(config, async (url, options) => {
    calls.push({ url, options });
    return json({ accepted: true });
  });
  await client.getEvent('ABC123');
  await client.startRound('ABC123', 'Team One');
  await client.submitRound('round-token', ['step-b', 'step-a']);
  await client.leaderboard('ABC123');
  assert.deepEqual(calls.map(({ url }) => new URL(url).pathname), [
    '/rest/v1/rpc/get_event', '/rest/v1/rpc/start_round', '/rest/v1/rpc/submit_round', '/rest/v1/rpc/get_leaderboard',
  ]);
  assert.deepEqual(calls.map(({ options }) => JSON.parse(options.body)), [
    { p_code: 'ABC123' }, { p_code: 'ABC123', p_name: 'Team One' },
    { p_token: 'round-token', p_order: ['step-b', 'step-a'] }, { p_code: 'ABC123' },
  ]);
  for (const { url, options } of calls) {
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.apikey, config.key);
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.credentials, 'omit');
    assert.ok(options.signal instanceof AbortSignal);
    assert.ok(!url.includes(config.key));
  }
});

test('legacy anon keys are compatible and host calls override the bearer with the host session', async () => {
  const calls = [];
  const key = jwt('anon');
  const client = createOnlineClient({ ...config, key }, async (url, options) => {
    calls.push({ url, options });
    return json({ code: 'event-code' });
  });
  await client.getEvent('event-code');
  const scenario = { title: 'Scenario', description: 'Arrange it.', steps: ['One', 'Two', 'Three'] };
  await client.createEvent('My event', scenario, 'host-token');
  await client.closeEvent('event-code', 'host-token');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${key}`);
  assert.deepEqual(JSON.parse(calls[1].options.body), { p_title: 'My event', p_scenario: scenario });
  assert.deepEqual(JSON.parse(calls[2].options.body), { p_code: 'event-code' });
  for (const call of calls.slice(1)) {
    assert.equal(call.options.headers.apikey, key);
    assert.equal(call.options.headers.Authorization, 'Bearer host-token');
  }
  assert.throws(() => client.createEvent('My event', scenario, ''), { code: 'unauthorized' });
  assert.throws(() => client.closeEvent('event-code'), { code: 'unauthorized' });
});

test('sign-in and refresh return expiring sessions; sign-out accepts an empty 204 response', async () => {
  const calls = [];
  const client = createOnlineClient(config, async (url, options) => {
    calls.push({ url, options });
    return url.endsWith('/logout') ? new Response(null, { status: 204 })
      : json({ access_token: 'host-access', refresh_token: 'host-refresh', expires_in: 3600 });
  });
  const now = Math.floor(Date.now() / 1000);
  const signedIn = await client.signIn('host@example.com', 'test-password');
  assert.ok(signedIn.expires_at >= now + 3600 && signedIn.expires_at <= now + 3601);
  assert.equal(signedIn.access_token, 'host-access');
  const refreshed = await client.refreshSession('host-refresh');
  assert.equal(refreshed.refresh_token, 'host-refresh');
  assert.equal(await client.signOut('host-access'), null);
  assert.deepEqual(calls.map(({ options }) => JSON.parse(options.body)), [
    { email: 'host@example.com', password: 'test-password' }, { refresh_token: 'host-refresh' }, {},
  ]);
  assert.equal(new URL(calls[0].url).searchParams.get('grant_type'), 'password');
  assert.equal(new URL(calls[1].url).searchParams.get('grant_type'), 'refresh_token');
  assert.equal(calls[2].options.headers.Authorization, 'Bearer host-access');
});

test('API failures are actionable without reflecting raw errors or credentials', async () => {
  for (const [status, code, expected] of [[400, 'invalid_credentials', 'invalid_credentials'], [401, 'PGRST301', 'unauthorized'], [403, '42501', 'forbidden'], [429, '', 'rate_limited'], [404, 'PGRST202', 'backend_not_ready'], [503, '', 'service_unavailable']]) {
    const client = createOnlineClient(config, async () => json({ code, message: `Do not show ${config.key}` }, status));
    await assert.rejects(client.getEvent('abc'), (error) => {
      assert.equal(error.code, expected);
      assert.equal(error.status, status);
      assert.ok(!error.message.includes(config.key));
      return true;
    });
  }
  const invalidJson = createOnlineClient(config, async () => new Response('not-json', { status: 200 }));
  await assert.rejects(invalidJson.getEvent('abc'), { code: 'invalid_response' });
  const networkError = createOnlineClient(config, async () => { throw new Error(`Network debug: ${config.key}`); });
  await assert.rejects(networkError.getEvent('abc'), (error) => error.code === 'network_error' && !error.message.includes(config.key));
});

test('known event errors explain how to recover without exposing arbitrary database messages', async () => {
  for (const [message, expected] of [
    ['Event not found. Check the event link or code.', 'event_not_found'],
    ['This event is closed. Ask the host for a new event link.', 'event_closed'],
    ['This event has expired. Ask the host for a new event link.', 'event_expired'],
    ['Submit every step exactly once for this round.', 'invalid_order'],
    ['Only the host can close this event.', 'forbidden'],
  ]) {
    const client = createOnlineClient(config, async () => json({ code: 'P0002', message }, 400));
    await assert.rejects(client.getEvent('abc'), { message, code: expected, status: 400 });
  }
  const client = createOnlineClient(config, async () => json({ code: 'P0002', message: 'Database detail containing private data' }, 400));
  await assert.rejects(client.getEvent('abc'), (error) => error.code === 'request_failed' && !error.message.includes('private data'));
});

test('a slow request is aborted after the timeout and reports a retryable error', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const client = createOnlineClient(config, async (_url, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  });
  const outcome = assert.rejects(client.getEvent('abc'), { code: 'timeout' });
  assert.equal(signal.aborted, false);
  context.mock.timers.tick(REQUEST_TIMEOUT_MS);
  await outcome;
  assert.equal(signal.aborted, true);
});
