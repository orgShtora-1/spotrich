import { execFileSync, spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../', import.meta.url));

// Do not run npm.cmd through a shell: paths and package arguments stay literal.
export function npmCli() {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    ...(process.env.PATH ?? '').split(delimiter).flatMap((directory) => [
      join(directory, 'node_modules/npm/bin/npm-cli.js'),
      join(directory, '../lib/node_modules/npm/bin/npm-cli.js'),
      join(directory, 'npm'),
    ]),
  ];
  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    const actual = realpathSync(candidate);
    if (actual.endsWith('npm-cli.js')) return actual;
  }
  throw new Error('npm CLI is missing. Install the supported Node.js distribution (including npm).');
}

export function isolatedEnv(directory) {
  // Allowlist: only pass through variables needed for OS/executable lookup and
  // build tooling. Explicitly exclude all credential-like names.
  const allowed = new Set([
    'PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC',
    'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS',
    'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP',
    'CI', 'NEXT_TELEMETRY_DISABLED', 'WRANGLER_SEND_METRICS',
    'SEMGREP_SEND_METRICS', 'SEMGREP_SETTINGS_FILE',
  ]);
  const env = {};
  for (const key of Object.keys(process.env)) {
    if (allowed.has(key)) env[key] = process.env[key];
  }
  const home = join(directory, 'home');
  const temp = join(directory, 'tmp');
  // Ensure isolated directories exist for HOME/TEMP to avoid falling back to user dirs.
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData/Roaming'),
    LOCALAPPDATA: join(home, 'AppData/Local'),
    TEMP: temp,
    TMP: temp,
    CI: '1',
    NEXT_TELEMETRY_DISABLED: '1',
    WRANGLER_SEND_METRICS: 'false',
    npm_config_userconfig: join(directory, 'empty-user.npmrc'),
    npm_config_globalconfig: join(directory, 'empty-global.npmrc'),
    npm_config_registry: 'https://registry.npmjs.org/',
    npm_config_ignore_scripts: 'true',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    npm_config_update_notifier: 'false',
    SEMGREP_SEND_METRICS: 'off',
    SEMGREP_SETTINGS_FILE: join(directory, 'semgrep-settings.yml'),
    npm_config_cache: join(directory, 'npm-cache'),
    BUN_INSTALL_CACHE_DIR: join(directory, 'bun-cache'),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(directory, 'bun-transpiler-cache'),
  };
}

export function runNode(args, { cwd = root, env = process.env, timeout = 120_000, capture = false } = {}) {
  return execFileSync(process.execPath, args, {
    cwd, env, timeout, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });
}

export function runNpm(args, options) {
  return runNode([npmCli(), ...args], options);
}

export async function temporaryDirectory(label) {
  const base = process.platform === 'win32'
    ? join(homedir(), 'AppData/Local/Temp/opencode')
    : tmpdir();
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, `spotrich-${label}-`));
  return {
    directory,
    // This closure can remove only the directory we just allocated, never a CLI path.
    cleanup: () => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
  };
}

export function startNode(args, { cwd, env }) {
  return spawn(process.execPath, args, {
    cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    detached: process.platform !== 'win32',
  });
}

export async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    // Kill only the process tree created by this harness (including build workers).
    execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  await new Promise((done) => {
    const timer = setTimeout(() => {
      if (process.platform !== 'win32') {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
          if (error.code !== 'ESRCH') process.stderr.write('Could not stop the fixture process group.\n');
        }
      }
      done();
    }, 5_000);
    child.once('exit', () => { clearTimeout(timer); done(); });
    if (child.exitCode !== null || child.signalCode !== null) { clearTimeout(timer); done(); }
  });
}

export function isMain(url) {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(url);
}
