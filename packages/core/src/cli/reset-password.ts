// Sets a temporary password for a user from the command line. For the case where the only
// administrator has lost theirs and nobody can reset it in the application.
//
//   node --import tsx src/cli/reset-password.ts <email> <temporary password>
//
// The user is signed out everywhere and must choose a new password at next sign-in.
import { getDb, loadRootEnv } from '@bluven/db';
import { normalizeEmail } from '../domain';
import { audit } from '../services/audit';
import { hashPassword, passwordProblem } from '../services/auth';

async function main(): Promise<void> {
  loadRootEnv();
  const [emailArg, password] = process.argv.slice(2);
  const email = normalizeEmail(emailArg ?? '');
  if (!email || !password) {
    console.error('Usage: reset-password.ts <email> <temporary password>');
    process.exit(2);
  }
  const db = getDb();
  const user = await db.user.findUnique({ where: { email } });
  if (!user) {
    console.error(`No user with the email ${email}.`);
    process.exit(1);
  }
  const problem = passwordProblem(password, email);
  if (problem) {
    console.error(`That password cannot be used: ${problem}`);
    process.exit(1);
  }
  const passwordHash = await hashPassword(password);
  await db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { passwordHash, mustChangePassword: true, failedLoginCount: 0, lockedUntil: null } });
    await tx.session.deleteMany({ where: { userId: user.id } });
    await audit(tx, { db, actor: { kind: 'system', label: 'Command line' } }, { action: 'user.password_reset', entityType: 'User', entityId: user.id, summary: `Reset password for ${user.email} from the command line` });
  });
  console.log(`Temporary password set for ${user.name} (${user.email}). They must choose a new one at next sign-in.${user.isActive ? '' : ' Note: this account is deactivated.'}`);
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
