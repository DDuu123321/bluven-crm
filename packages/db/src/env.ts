import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let loaded = false;

/**
 * Loads the repository-root `.env` file into `process.env` once.
 * Variables that are already set (for example by Docker) are left untouched.
 */
export function loadRootEnv(): void {
  if (loaded) return;
  loaded = true;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, '../../..');
  const file = path.join(root, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

/** Absolute path of the repository root. */
export function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../..');
}
