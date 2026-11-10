import { existsSync } from 'node:fs';
import path from 'node:path';

let root: string | undefined;
let loaded = false;

/**
 * Absolute path of the repository root: the nearest ancestor of the working directory that holds
 * `pnpm-workspace.yaml`. Falls back to the working directory (for example inside a container
 * image that only ships the built application).
 */
export function repoRoot(): string {
  if (root) return root;
  let dir = process.cwd();
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return (root = dir);
    const parent = path.dirname(dir);
    if (parent === dir) return (root = process.cwd());
    dir = parent;
  }
}

/**
 * Loads the repository-root `.env` file into `process.env` once.
 * Variables that are already set (for example by Docker) are left untouched.
 */
export function loadRootEnv(): void {
  if (loaded) return;
  loaded = true;
  const file = path.join(repoRoot(), '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}
