// Gives a user a new temporary password from the command line. For the case where the only
// administrator has lost theirs and nobody can reset it in the application.
//
//   node --import tsx src/cli/reset-password.ts <email>
//
// The password is generated here and printed once. It is not taken as an argument, because
// command lines end up in shell history and process lists. The user is signed out everywhere,
// any lock on the account is lifted, and they must choose a new password at next sign-in.
import { randomInt } from 'node:crypto';
import { getDb, loadRootEnv } from '@bluven/db';
import { normalizeEmail } from '../domain';
import { audit } from '../services/audit';
import { hashPassword, passwordProblem } from '../services/auth';

// No look-alikes (0/O, 1/l/I), so it can be read out over the phone.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

function temporaryPassword(): string {
  const group = () => Array.from({ length: 5 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return `${group()}-${group()}-${group()}`;
}

async function main(): Promise<void> {
  loadRootEnv();
  const email = normalizeEmail(process.argv[2] ?? '');
  if (!email || process.argv.length > 3) {
    console.error('Usage: reset-password.ts <email>');
    process.exit(2);
  }
  const db = getDb();
  const user = await db.user.findUnique({ where: { email } });
  if (!user) {
    console.error(`No user with the email ${email}.`);
    process.exit(1);
  }
  let password = temporaryPassword();
  while (passwordProblem(password, email)) password = temporaryPassword();
  const passwordHash = await hashPassword(password);
  await db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { passwordHash, mustChangePassword: true, failedLoginCount: 0, lockedUntil: null } });
    await tx.session.deleteMany({ where: { userId: user.id } });
    await audit(tx, { db, actor: { kind: 'system', label: 'Command line' } }, { action: 'user.password_reset', entityType: 'User', entityId: user.id, summary: `Reset password for ${user.email} from the command line` });
  });
  console.log(`Temporary password for ${user.name} (${user.email}):\n\n    ${password}\n\nIt is shown only this once. They must choose a new one at next sign-in.${user.isActive ? '' : ' Note: this account is deactivated.'}`);
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
