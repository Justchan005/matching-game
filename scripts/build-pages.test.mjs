import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildPages } from './build-pages.mjs';

const ASSETS = ['index.html', 'styles.css', 'online.css', 'app.mjs', 'game-core.mjs', 'online.mjs', 'online-api.mjs'];

async function fixture(t, config = { supabaseUrl: '', supabaseKey: '' }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flow-pages-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all(ASSETS.map((name) => writeFile(path.join(root, name), `public asset: ${name}`)));
  await writeFile(path.join(root, 'config.json'), JSON.stringify(config));
  return root;
}

test('publishes only browser assets and replaces stale output', async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, '.git'));
  await writeFile(path.join(root, '.git', 'config'), 'private repository metadata');
  await mkdir(path.join(root, 'supabase'));
  await writeFile(path.join(root, 'supabase', 'migration.sql'), 'private schema');
  await writeFile(path.join(root, '.env'), 'private settings');
  await mkdir(path.join(root, 'dist'));
  await writeFile(path.join(root, 'dist', 'stale.txt'), 'old artifact');
  const result = await buildPages({ root, env: {} });
  assert.equal(result.configured, false);
  assert.deepEqual((await readdir(result.outDir)).sort(), [...ASSETS, 'config.json', '.nojekyll'].sort());
  assert.equal(await readFile(path.join(result.outDir, 'app.mjs'), 'utf8'), 'public asset: app.mjs');
  assert.deepEqual(JSON.parse(await readFile(path.join(result.outDir, 'config.json'), 'utf8')), { supabaseUrl: '', supabaseKey: '' });
});

test('uses public config and lets deployment variables override it without copying extra fields', async (t) => {
  const root = await fixture(t, { supabaseUrl: 'https://stored.supabase.co', supabaseKey: 'sb_publishable_stored', privateNote: 'not for publication' });
  const result = await buildPages({ root, env: { SUPABASE_URL: 'https://deployed.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_deployed' } });
  assert.equal(result.configured, true);
  assert.deepEqual(JSON.parse(await readFile(path.join(result.outDir, 'config.json'), 'utf8')), {
    supabaseUrl: 'https://deployed.supabase.co', supabaseKey: 'sb_publishable_deployed',
  });
  await buildPages({ root, env: { SUPABASE_URL: '', SUPABASE_PUBLISHABLE_KEY: '' } });
  assert.deepEqual(JSON.parse(await readFile(path.join(result.outDir, 'config.json'), 'utf8')), {
    supabaseUrl: 'https://stored.supabase.co', supabaseKey: 'sb_publishable_stored',
  });
});

test('rejects incomplete configuration, secret keys, and service-role JWTs', async (t) => {
  const root = await fixture(t);
  await assert.rejects(buildPages({ root, env: { SUPABASE_URL: 'https://example.supabase.co' } }), /Cannot build online mode/);
  await assert.rejects(buildPages({ root, env: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_secret_do_not_publish' } }), /Cannot build online mode/);
  const payload = Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url');
  await assert.rejects(buildPages({ root, env: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_PUBLISHABLE_KEY: `e30.${payload}.signature` } }), /Cannot build online mode/);
});

test('rejects unsafe output locations and linked runtime files', async (t) => {
  const root = await fixture(t);
  await assert.rejects(buildPages({ root, outDir: '..', env: {} }), /output directory/);
  await assert.rejects(buildPages({ root, outDir: '.', env: {} }), /output directory/);
  await assert.rejects(buildPages({ root, outDir: '.git', env: {} }), /output directory/);
  if (process.platform === 'win32') return; // Symlink creation may require Windows developer mode.
  await rm(path.join(root, 'online.mjs'));
  await symlink(path.join(root, 'app.mjs'), path.join(root, 'online.mjs'));
  await assert.rejects(buildPages({ root, env: {} }), /regular files/);
});
