import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === 'node_modules' || name === 'generated' ? [] : sources(full);
    return /\.ts$/.test(name) ? [full] : [];
  });
}

describe('background jobs', () => {
  // Two jobs with the same lock keep each other from running: whichever starts second is skipped.
  it('each have a lock of their own', () => {
    const keys = new Map<number, string>();
    const clashes: string[] = [];
    for (const file of ['packages/core/src', 'packages/integrations/src', 'apps/worker/src'].flatMap((dir) => sources(path.join(root, dir)))) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/(?:withJobLock\([^,]+,\s*|LOCK_KEY\s*=\s*)(\d{6})/g)) {
        const key = Number(m[1]);
        const where = path.relative(root, file);
        if (keys.has(key)) clashes.push(`${key}: ${keys.get(key)} and ${where}`);
        keys.set(key, where);
      }
    }
    expect(clashes).toEqual([]);
    expect(keys.size).toBeGreaterThanOrEqual(10);
  });
});
