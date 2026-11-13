import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from './generated/prisma/client';
import { loadRootEnv } from './env';

export * from './generated/prisma/client';
export { loadRootEnv, repoRoot } from './env';

/** The database client. */
export type Db = PrismaClient;
/** A client bound to an interactive transaction. */
export type Tx = Prisma.TransactionClient;
/** Either the root client or a transaction client. */
export type DbOrTx = Db | Tx;

/**
 * How long a query waits for a free connection. Without a limit, a pool whose connections are
 * all taken makes every further query hang for good; with one it fails and says why.
 */
const POOL_WAIT_MS = 20_000;

// Kept on the process, not on this module: the web application can hold more than one copy of
// the module, and all of them must share the one client and what is known about it.
const globalForDb = globalThis as unknown as { __bluvenDb?: PrismaClient; __bluvenDbUrls?: WeakMap<PrismaClient, string> };
/** The connection string each client was created with. */
const connectionStrings = (globalForDb.__bluvenDbUrls ??= new WeakMap<PrismaClient, string>());

/**
 * Creates a new client for the given connection string. Prefer getDb() in application code.
 * `poolWaitMs` is how long a query waits for a free connection before it fails.
 */
export function createDb(connectionString: string, poolWaitMs: number = POOL_WAIT_MS): PrismaClient {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString, connectionTimeoutMillis: poolWaitMs }) });
  connectionStrings.set(db, connectionString);
  return db;
}

/** Process-wide client, created lazily from DATABASE_URL. */
export function getDb(): PrismaClient {
  if (!globalForDb.__bluvenDb) {
    loadRootEnv();
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    globalForDb.__bluvenDb = createDb(url);
  }
  return globalForDb.__bluvenDb;
}

/**
 * Opens a connection of its own to the database behind `db`, outside the pool. For what has to
 * stay on one connection for as long as it takes, such as the lock of a background job. The
 * caller listens for its 'error' event and closes it with end().
 */
export async function openConnection(db: Db): Promise<pg.Client> {
  const connectionString = connectionStrings.get(db);
  if (!connectionString) throw new Error('This database client was not made by createDb().');
  // It sits idle while the work goes on elsewhere: keep-alive stops a firewall from dropping it as dead.
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: POOL_WAIT_MS, keepAlive: true });
  await client.connect();
  return client;
}
