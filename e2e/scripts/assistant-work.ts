// Does one round of the assistant's background work, the way the worker does every minute. The
// end-to-end tests run the application without the worker, so they call this instead.
import { systemCtx } from '@bluven/core';
import { createDb } from '@bluven/db';
import { assistantModel, runAssistantWork } from '@bluven/integrations';
import { E2E } from '../env';

const db = createDb(E2E.databaseUrl);
const model = assistantModel();
if (!model) throw new Error('The stand-in model is not configured.');
// A customer's e-mail has to have settled for two minutes before the summary is rewritten; the
// tests do not wait that long, so the clock of this one round runs three minutes ahead.
const now = () => new Date(Date.now() + (process.argv.includes('--later') ? 3 * 60_000 : 0));
const result = await runAssistantWork(systemCtx(db, 'Assistant', now), model);
console.log(JSON.stringify(result));
await db.$disconnect();
