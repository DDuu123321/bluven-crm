// Starts the whole application in one container: database migrations first, then the web server
// and the background worker side by side. This is what the default image runs, for platforms
// that run one container per service with one disk attached (Railway and similar). The Docker
// Compose setup does not use it: there the web server and the worker are separate containers.
//
// The container may start as root, because a freshly attached disk usually belongs to root. The
// disk is handed to the unprivileged "node" user here and everything else runs as that user.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE_USER = { uid: 1000, gid: 1000 };
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const unprivileged = isRoot ? NODE_USER : {};
const env = { ...process.env, HOME: isRoot ? '/home/node' : process.env.HOME, HOSTNAME: '0.0.0.0', NODE_ENV: 'production' };
const log = (text) => console.log(`[start] ${text}`);

function fail(text) {
  console.error(`[start] ${text}`);
  process.exit(1);
}

for (const name of ['DATABASE_URL', 'APP_URL']) {
  if (!process.env[name]) fail(`${name} is not set. See docs/deployment-guide.md for the variables this application needs.`);
}

// 1. The folder for uploaded files exists and can be written by the application.
const storage = process.env.STORAGE_DIR || '/data/storage';
try {
  mkdirSync(storage, { recursive: true });
  if (isRoot && statSync(storage).uid !== NODE_USER.uid) {
    log(`handing ${storage} to the application user`);
    const done = spawnSync('chown', ['-R', `${NODE_USER.uid}:${NODE_USER.gid}`, storage], { stdio: 'inherit' });
    if (done.status !== 0) fail(`could not change the owner of ${storage}`);
  }
} catch (e) {
  fail(`the storage folder ${storage} cannot be prepared: ${e instanceof Error ? e.message : e}`);
}

// 2. Bring the database up to date and make sure the reference data and first administrator exist.
//    Both steps do nothing when there is nothing to do, so they run on every start.
function step(label, cwd, command, args) {
  log(label);
  const done = spawnSync(command, args, { cwd: path.join(repo, cwd), env, stdio: 'inherit', ...unprivileged });
  if (done.status !== 0) fail(`"${label}" failed. The application was not started.`);
}
step('database migrations', 'packages/db', 'node_modules/.bin/prisma', ['migrate', 'deploy']);
step('reference data', 'packages/core', 'node', ['--import', 'tsx', 'src/seed.ts']);

// 3. Web server and worker. If either stops, stop the other and exit, so the platform restarts the container.
const children = new Map();
let stopping = false;

function start(name, cwd, args) {
  const child = spawn('node', args, { cwd: path.join(repo, cwd), env, stdio: 'inherit', ...unprivileged });
  children.set(name, child);
  child.on('exit', (code, signal) => {
    children.delete(name);
    if (!stopping) {
      console.error(`[start] ${name} stopped unexpectedly (${signal ?? `exit code ${code}`}); shutting down so the container is restarted`);
      shutdown(code === 0 ? 1 : (code ?? 1));
    } else if (children.size === 0) {
      process.exit(exitCode);
    }
  });
  return child;
}

let exitCode = 0;
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  exitCode = code;
  for (const child of children.values()) child.kill('SIGTERM');
  if (children.size === 0) process.exit(code);
  // Do not hang for ever on a child that ignores the signal.
  setTimeout(() => process.exit(code), 25_000).unref();
}
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

start('web', 'apps/web/.next/standalone/apps/web', ['server.js']);
start('worker', 'apps/worker', ['--import', 'tsx', 'src/index.ts']);
log(`web server on port ${process.env.PORT || 3000}, worker running; files in ${storage}`);
