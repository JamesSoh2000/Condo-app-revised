import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** The repository root: compose files are relative to it. */
const ROOT = path.resolve(import.meta.dirname, '..', '..');

/** The stack's compose file and its API service (`make e2e` sets both: `app` on the dev stack, `api` prod-like). */
const COMPOSE_FILE = process.env.E2E_COMPOSE_FILE ?? 'docker-compose.yml';
const API_SERVICE = process.env.E2E_API_SERVICE ?? 'app';

/**
 * Runs an operator command (`python -m app.cli …`) in the stack's API container and returns its stdout. Arguments
 * go to `docker` as an argv, never through a shell. A non-zero exit rejects with the command's stderr.
 */
export async function runCli(args: string[]): Promise<string> {
  const { stdout } = await run(
    'docker',
    ['compose', '-f', COMPOSE_FILE, 'exec', '-T', '-e', 'OPERATOR=e2e', API_SERVICE, 'python', '-m', 'app.cli', ...args],
    { cwd: ROOT, timeout: 60_000 },
  );
  return stdout;
}

/**
 * Empties the rate-limit windows (`rate_limits`) in the stack's database. A retried test repeats its signups,
 * invitation lookups and logins from the same IP; this gives the retry the budget the first attempt had, with the
 * limits themselves unchanged (P4-09 review round 1, F2).
 */
export async function resetRateLimits(): Promise<void> {
  await run(
    'docker',
    [
      'compose', '-f', COMPOSE_FILE, 'exec', '-T', 'db', 'sh', '-c',
      'psql -q -v ON_ERROR_STOP=1 -U postgres -d "$POSTGRES_DB" -c "DELETE FROM rate_limits"',
    ],
    { cwd: ROOT, timeout: 60_000 },
  );
}
