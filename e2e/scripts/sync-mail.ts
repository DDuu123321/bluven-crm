// Reads every connected mailbox once, the way the worker does every minute. The end-to-end
// tests run the application without the worker, so they call this when they want mail to arrive.
import { systemCtx } from '@bluven/core';
import { createDb } from '@bluven/db';
import { mailApiFactory, syncAllMailboxes } from '@bluven/integrations';
import { E2E } from '../env';

const db = createDb(E2E.databaseUrl);
const result = await syncAllMailboxes(systemCtx(db, 'Mail'), mailApiFactory(db));
console.log(JSON.stringify(result));
await db.$disconnect();
