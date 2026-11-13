// The lock that keeps two worker instances from running the same job at once, and the pool the
// jobs share.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '@bluven/db';
import { withJobLock } from '../src';
import { testDb } from './helpers';

const db = testDb();
// Keys no real job uses.
const KEY = 769_901;

/** Something a test can wait for, and let go of. */
function gate(): { reached: Promise<void>; open: () => void } {
  let open!: () => void;
  const reached = new Promise<void>((resolve) => (open = resolve));
  return { reached, open };
}

interface Holder {
  pid: number;
  state: string;
  inTransaction: boolean;
}

/** The connections that hold the lock with this key, as the database sees them. */
const holders = (key: number) => db.$queryRaw<Holder[]>`
  SELECT a.pid, a.state, a.xact_start IS NOT NULL AS "inTransaction"
  FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
  WHERE l.locktype = 'advisory' AND l.granted AND l.classid = 0 AND l.objid::bigint = ${key}
    AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())`;

async function until(condition: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('gave up waiting');
}

afterEach(() => vi.restoreAllMocks());

describe('the job lock', () => {
  it('lets one run in and turns a second one away, from the same worker or another', async () => {
    const started = gate();
    const finish = gate();
    const first = withJobLock(db, KEY, async () => {
      started.open();
      await finish.reached;
      return 'first';
    });
    await started.reached;
    expect(await withJobLock(db, KEY, async () => 'second')).toBeNull();
    const otherWorker = createDb(process.env.DATABASE_URL_TEST!);
    expect(await withJobLock(otherWorker, KEY, async () => 'other worker')).toBeNull();
    await otherWorker.$disconnect();
    // A different job is not held up.
    expect(await withJobLock(db, KEY + 1, async () => 'another job')).toBe('another job');

    finish.open();
    expect(await first).toBe('first');
  });

  it('is free again as soon as the run is over, whether it finished or failed', async () => {
    expect(await withJobLock(db, KEY, async () => 1)).toBe(1);
    expect(await withJobLock(db, KEY, async () => 2)).toBe(2);
    await expect(
      withJobLock(db, KEY, async () => {
        throw new Error('the job broke');
      }),
    ).rejects.toThrow('the job broke');
    expect(await withJobLock(db, KEY, async () => 3)).toBe(3);
    expect(await holders(KEY)).toEqual([]);
  });

  it('holds the lock on a connection of its own and outside any transaction, so no time limit can end it mid-job', async () => {
    const seen = await withJobLock(db, KEY, async () => {
      const [job] = await db.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      return { holders: await holders(KEY), jobPid: job!.pid };
    });
    expect(seen!.holders).toHaveLength(1);
    // Idle and not in a transaction: there is nothing on it that a timeout could roll back,
    // however long the job goes on. It used to be a transaction that was closed after ten minutes.
    expect(seen!.holders[0]).toMatchObject({ state: 'idle', inTransaction: false });
    expect(seen!.holders[0]!.pid).not.toBe(seen!.jobPid);
  });

  it('leaves the pool to the jobs: more of them at once than the pool has connections all get their work done', async () => {
    const keys = Array.from({ length: 14 }, (_, i) => KEY + 10 + i);
    const done = await Promise.all(
      keys.map((key) =>
        withJobLock(db, key, async () => {
          // The work itself goes through the pool, as it does in the real jobs.
          await db.$queryRaw`SELECT 1 AS one FROM pg_sleep(0.05)`;
          return key;
        }),
      ),
    );
    expect(done).toEqual(keys);
  });

  it('goes when its connection goes, as after a crash, without taking the job or the worker down', async () => {
    const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const outcome = await withJobLock(db, KEY, async () => {
      const [holder] = await holders(KEY);
      await db.$queryRaw`SELECT pg_terminate_backend(${holder!.pid}::int)::text AS ended`;
      await until(async () => (await holders(KEY)).length === 0);
      // Nothing is left behind: another worker can take the job over straight away.
      return withJobLock(db, KEY, async () => 'taken over');
    });
    expect(outcome).toBe('taken over');
    expect(reported).toHaveBeenCalledWith(expect.stringContaining(`job lock ${KEY}`), expect.any(String));
  });
});

describe('the connection pool', () => {
  it('fails a query that cannot get a connection in time, instead of leaving it to hang', async () => {
    const small = createDb(process.env.DATABASE_URL_TEST!, 300);
    // Every connection of the pool is busy for a second and a half. (A Prisma query starts once it is waited for.)
    const busy = Array.from({ length: 10 }, () => small.$queryRaw`SELECT 1 AS one FROM pg_sleep(1.5)`.then(() => undefined));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const asked = Date.now();
    await expect(small.user.count()).rejects.toThrow('timeout exceeded when trying to connect');
    expect(Date.now() - asked).toBeLessThan(1_200);
    await Promise.all(busy);
    // Once connections are free again everything works as before.
    expect(await small.user.count()).toBeGreaterThanOrEqual(0);
    await small.$disconnect();
  });
});
