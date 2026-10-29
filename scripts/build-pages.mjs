import { copyFile, lstat, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateOnlineConfig } from '../online-api.mjs';

const RUNTIME_FILES = ['index.html', 'styles.css', 'online.css', 'app.mjs', 'game-core.mjs', 'online.mjs', 'online-api.mjs'];
const DEFAULT_ROOT = fileURLToPath(new URL('../', import.meta.url));

async function requireRegularFile(filename) {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Runtime source files must be regular files, not links.');
}

/** Build only public browser assets. Never publish the checkout as a whole. */
export async function buildPages({ root = DEFAULT_ROOT, outDir = 'dist', env = process.env } = {}) {
  const projectRoot = await realpath(root);
  const destination = path.resolve(projectRoot, outDir);
  if (path.dirname(destination) !== projectRoot || path.basename(destination).startsWith('.')) {
    throw new Error('The output directory must be a non-hidden direct child of the project directory.');
  }
  try {
    const existing = await lstat(destination);
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error('The output path must be a directory, not a file or link.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const configPath = path.join(projectRoot, 'config.json');
  await requireRegularFile(configPath);
  let stored;
  try { stored = JSON.parse(await readFile(configPath, 'utf8')); }
  catch { throw new Error('config.json must contain valid JSON.'); }
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw new Error('config.json must contain a configuration object.');
  const config = {
    supabaseUrl: env.SUPABASE_URL?.trim() || stored.supabaseUrl || '',
    supabaseKey: env.SUPABASE_PUBLISHABLE_KEY?.trim() || stored.supabaseKey || '',
  };
  const configured = Boolean(config.supabaseUrl || config.supabaseKey);
  if (configured) {
    const validation = validateOnlineConfig({ url: config.supabaseUrl, key: config.supabaseKey });
    if (!validation.valid) throw new Error(`Cannot build online mode: ${validation.error}`);
  }
  await Promise.all(RUNTIME_FILES.map((filename) => requireRegularFile(path.join(projectRoot, filename))));

  const staging = await mkdtemp(path.join(projectRoot, '.pages-build-'));
  try {
    await Promise.all(RUNTIME_FILES.map((filename) => copyFile(path.join(projectRoot, filename), path.join(staging, filename))));
    await writeFile(path.join(staging, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(path.join(staging, '.nojekyll'), '');
    await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return { outDir: destination, configured, files: [...RUNTIME_FILES, 'config.json', '.nojekyll'] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await buildPages();
    console.log(`Prepared the static site in ${path.basename(result.outDir)}/ (${result.configured ? 'shared events configured' : 'local play only'}).`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
