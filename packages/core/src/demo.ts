// Puts the demo accounts and orders into an empty database, for looking around on your own
// computer. Run with `pnpm db:demo` after `pnpm db:deploy`. It refuses to run unless DEMO_DATA=1
// is set, and it leaves a database alone that already has a user or an order.
import { getDb, loadRootEnv } from '@bluven/db';
import { DEMO_PASSWORD, DEMO_USERS, createDemoData } from './services/demo';

async function main(): Promise<void> {
  loadRootEnv();
  if (process.env.DEMO_DATA !== '1') {
    console.error('This fills the database with sample accounts and orders. Set DEMO_DATA=1 to say that is what you want.');
    process.exit(1);
  }
  const db = getDb();
  const made = await createDemoData(db);
  if (made) {
    console.log(`Demo data is in place: ${made.orders} orders and these accounts, all with the password ${DEMO_PASSWORD}`);
    for (const u of DEMO_USERS) console.log(`  ${u.email.padEnd(22)} ${u.name} (${u.roles.join(', ').toLowerCase()})`);
  } else {
    console.log('The database already has users or orders: no demo data was added.');
  }
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
