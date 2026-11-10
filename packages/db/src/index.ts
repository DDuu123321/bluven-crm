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

const globalForDb = globalThis as unknown as { __bluvenDb?: PrismaClient };

/** Creates a new client for the given connection string. Prefer getDb() in application code. */
export function createDb(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
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
