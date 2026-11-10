// Runs the production build the same way the container image does: the standalone server that
// `next build` writes to .next/standalone, with the static assets copied next to it.
import { cpSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const standalone = path.join(appDir, '.next/standalone/apps/web');
const server = path.join(standalone, 'server.js');

if (!existsSync(server)) {
  console.error('No production build found. Run `pnpm build` first.');
  process.exit(1);
}
cpSync(path.join(appDir, '.next/static'), path.join(standalone, '.next/static'), { recursive: true });
if (existsSync(path.join(appDir, 'public'))) cpSync(path.join(appDir, 'public'), path.join(standalone, 'public'), { recursive: true });

process.env.PORT ??= '3000';
process.env.HOSTNAME ??= '0.0.0.0';
process.chdir(standalone);
await import(pathToFileURL(server).href);
