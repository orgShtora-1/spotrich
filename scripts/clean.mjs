import { lstat, readdir, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { isMain, root } from './lib/host.mjs';

async function generatedNames(source, prefix = '') {
  const names = new Set();
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error('Refusing a symlinked source tree.');
    if (entry.isDirectory()) {
      for (const child of await generatedNames(join(source, entry.name), `${name}/`)) names.add(child);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      const stem = name.slice(0, -3);
      for (const extension of ['.js', '.d.ts', '.js.map', '.d.ts.map']) names.add(`${stem}${extension}`);
    }
  }
  return names;
}

export async function cleanGeneratedDist(project = root) {
  const destination = join(project, 'dist');
  let info;
  try { info = await lstat(destination); } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Refusing to clean a non-directory or symlinked dist.');
  const allowed = await generatedNames(join(project, 'src'));
  async function validate(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const name = relative(destination, path).replaceAll('\\', '/');
      if (entry.isSymbolicLink()) throw new Error(`Refusing to clean symlink: dist/${name}`);
      if (entry.isDirectory()) {
        if (![...allowed].some((file) => file.startsWith(`${name}/`))) {
          throw new Error(`Unknown directory in dist; preserving it: ${name}`);
        }
        await validate(path);
      } else if (!entry.isFile() || !allowed.has(name)) {
        throw new Error(`Unknown file in dist; preserving all output: ${name}`);
      }
    }
  }
  // Validate the entire tree before deleting anything. No arbitrary output/path flag.
  await validate(destination);
  await rm(destination, { recursive: true, maxRetries: 5, retryDelay: 100 });
  return true;
}

if (isMain(import.meta.url)) {
  try {
    if (process.argv.length > 2) throw new Error('clean takes no arguments; it owns only generated dist.');
    process.stdout.write(await cleanGeneratedDist() ? 'Removed generated dist.\n' : 'No dist to clean.\n');
  } catch (error) {
    process.stderr.write(`clean: ${error.message}\n`);
    process.exitCode = 1;
  }
}
