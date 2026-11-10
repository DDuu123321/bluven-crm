// Prepares a database for use: reference data plus the first admin account.
// Run with `pnpm db:seed`. Safe to run again at any time.
import { getDb, loadRootEnv } from '@bluven/db';
import { ensureFirstAdmin } from './services/auth';
import { ensureReferenceData } from './services/reference';

async function main(): Promise<void> {
  loadRootEnv();
  const db = getDb();
  await ensureReferenceData(db);
  console.log('Reference data is in place (document types, lost reasons, lead sources).');

  const email = process.env.SEED_ADMIN_EMAIL?.trim();
  const password = process.env.SEED_ADMIN_PASSWORD ?? '';
  if (!email) {
    console.log('SEED_ADMIN_EMAIL is not set: no admin account was created.');
  } else {
    const outcome = await ensureFirstAdmin(db, { email, name: process.env.SEED_ADMIN_NAME ?? 'Admin', password });
    console.log(
      outcome === 'created'
        ? `Created the first admin account: ${email}. You will be asked to choose a new password at first sign-in.`
        : 'Users already exist: no admin account was created.',
    );
  }
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
