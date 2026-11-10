import { beforeEach, describe, expect, it } from 'vitest';
import {
  authenticateIntakeToken,
  changeOwnPassword,
  createDocumentType,
  createLeadSource,
  createLostReason,
  createUser,
  getHandoffChecklist,
  getSessionUser,
  login,
  logout,
  resetAttemptLimits,
  resetUserPassword,
  revokePreviousIntakeToken,
  rotateIntakeToken,
  updateCustomer,
  updateDocumentType,
  updateLeadSource,
  updateUser,
  verifyPassword,
} from '../src';
import { Clock, as, makeUser, resetDb, source, testDb, type TestUser } from './helpers';
import { makeWorld, orderAt } from './setup-order';

const db = testDb();
let admin: TestUser;

beforeEach(async () => {
  await resetDb();
  resetAttemptLimits();
  admin = await makeUser(['ADMIN'], 'Ada Admin');
});

describe('sign-in and sessions', () => {
  const password = 'Correct-horse-battery';

  it('creates users with a temporary password that must be changed', async () => {
    const { id } = await createUser(as(admin), { email: ' New.Person@Bluven.test ', name: 'New Person', roles: ['SALES'], password });
    const user = await db.user.findUniqueOrThrow({ where: { id } });
    expect(user).toMatchObject({ email: 'new.person@bluven.test', mustChangePassword: true, roles: ['SALES'] });
    expect(user.passwordHash).not.toContain(password);
    expect(await verifyPassword(password, user.passwordHash)).toBe(true);
    expect(await verifyPassword('wrong', user.passwordHash)).toBe(false);
    await expect(createUser(as(admin), { email: 'new.person@bluven.test', name: 'Dup', roles: ['SALES'], password })).rejects.toMatchObject({ fieldErrors: { email: expect.any(String) } });
    await expect(createUser(as(admin), { email: 'x@bluven.test', name: '', roles: [], password: 'short' })).rejects.toMatchObject({
      fieldErrors: { name: expect.any(String), roles: expect.any(String), password: expect.any(String) },
    });
    const sales = await makeUser(['SALES']);
    await expect(createUser(as(sales), { email: 'y@bluven.test', name: 'Y', roles: ['ADMIN'], password })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('signs in, resolves the session, and signs out', async () => {
    await createUser(as(admin), { email: 'sam@bluven.test', name: 'Sam', roles: ['SALES'], password });
    const { token, user } = await login(db, { email: 'SAM@bluven.test', password });
    expect(user).toMatchObject({ name: 'Sam', roles: ['SALES'], mustChangePassword: true });
    expect(await getSessionUser(db, token)).toMatchObject({ email: 'sam@bluven.test' });
    expect(await getSessionUser(db, 'not-a-token')).toBeNull();
    // The token itself is never stored.
    expect(await db.session.count({ where: { tokenHash: token } })).toBe(0);
    await logout(db, token);
    expect(await getSessionUser(db, token)).toBeNull();
  });

  it('gives the same answer for a wrong password and an unknown account', async () => {
    await createUser(as(admin), { email: 'sam@bluven.test', name: 'Sam', roles: ['SALES'], password });
    const wrong = await login(db, { email: 'sam@bluven.test', password: 'nope-nope-nope' }).catch((e: Error) => e.message);
    const unknown = await login(db, { email: 'ghost@bluven.test', password }).catch((e: Error) => e.message);
    expect(wrong).toBe('Incorrect email or password.');
    expect(unknown).toBe(wrong);
  });

  it('locks the account for a while after repeated failures', async () => {
    await createUser(as(admin), { email: 'sam@bluven.test', name: 'Sam', roles: ['SALES'], password });
    const clock = new Clock();
    for (let i = 0; i < 5; i++) await login(db, { email: 'sam@bluven.test', password: 'bad-password-x', now: clock.current }).catch(() => undefined);
    await expect(login(db, { email: 'sam@bluven.test', password, now: clock.current })).rejects.toMatchObject({ message: expect.stringContaining('Too many failed attempts') });
    clock.advanceMinutes(6);
    const ok = await login(db, { email: 'sam@bluven.test', password, now: clock.current });
    expect(ok.user.name).toBe('Sam');
    expect((await db.user.findUniqueOrThrow({ where: { email: 'sam@bluven.test' } })).failedLoginCount).toBe(0);
    expect(await db.auditLog.count({ where: { action: 'auth.login_failed' } })).toBe(5);
  });

  it('does not let the answers tell an account from an address nobody has', async () => {
    await createUser(as(admin), { email: 'sam@bluven.test', name: 'Sam', roles: ['SALES'], password });
    const clock = new Clock();
    const attempt = (email: string) => login(db, { email, password: 'bad-password-x', now: clock.current }).then(() => 'signed in', (e: Error) => e.message);
    const real: string[] = [];
    const ghost: string[] = [];
    for (let i = 0; i < 7; i++) {
      real.push(await attempt('sam@bluven.test'));
      ghost.push(await attempt('ghost@bluven.test'));
    }
    // Later on too: the account is now locked in the database for longer than the short-term limit lasts.
    clock.advanceMinutes(6);
    for (let i = 0; i < 3; i++) {
      real.push(await attempt('sam@bluven.test'));
      ghost.push(await attempt('ghost@bluven.test'));
    }
    expect(real).toEqual(ghost);
    expect(real.slice(0, 5)).toEqual(Array(5).fill('Incorrect email or password.'));
    expect(real[5]).toMatch(/^Too many failed attempts\. Try again in \d+ minutes?\.$/);
  });

  it('holds the limit when many guesses arrive at the same moment', async () => {
    await createUser(as(admin), { email: 'sam@bluven.test', name: 'Sam', roles: ['SALES'], password });
    const clock = new Clock();
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => login(db, { email: 'sam@bluven.test', password: `guess-number-${i}`, now: clock.current })));
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    // Only five of the twenty were ever compared with the real password.
    expect(await db.auditLog.count({ where: { action: 'auth.login_failed' } })).toBe(5);
    const user = await db.user.findUniqueOrThrow({ where: { email: 'sam@bluven.test' } });
    expect(user.failedLoginCount).toBe(5);
    expect(user.lockedUntil!.getTime()).toBe(clock.current.getTime() + 60_000);
  });

  it('keeps the lock on the account itself, with longer locks for further failures', async () => {
    await createUser(as(admin), { email: 'sam@bluven.test', name: 'Sam', roles: ['SALES'], password });
    const clock = new Clock();
    for (let i = 0; i < 5; i++) await login(db, { email: 'sam@bluven.test', password: 'bad-password-x', now: clock.current }).catch(() => undefined);
    // Even if the short-term counter is gone (say the server restarted), the account stays locked,
    // and the right password is answered like a wrong one rather than being tried.
    resetAttemptLimits();
    await expect(login(db, { email: 'sam@bluven.test', password, now: clock.current })).rejects.toMatchObject({ message: 'Incorrect email or password.' });
    expect(await db.session.count()).toBe(0);
    expect(await db.auditLog.count({ where: { action: 'auth.login_failed' } })).toBe(5);

    // One more failure after the lock has run out locks for twice as long.
    clock.advanceMinutes(2);
    resetAttemptLimits();
    await login(db, { email: 'sam@bluven.test', password: 'bad-password-y', now: clock.current }).catch(() => undefined);
    const user = await db.user.findUniqueOrThrow({ where: { email: 'sam@bluven.test' } });
    expect(user.failedLoginCount).toBe(6);
    expect(user.lockedUntil!.getTime()).toBe(clock.current.getTime() + 2 * 60_000);

    // An administrator's reset lifts it.
    await resetUserPassword(as(admin), { userId: user.id, password: 'Temporary-pass-22' });
    resetAttemptLimits();
    expect((await login(db, { email: 'sam@bluven.test', password: 'Temporary-pass-22', now: clock.current })).user.mustChangePassword).toBe(true);
  });

  it('refuses absurdly long passwords without hashing them', async () => {
    await createUser(as(admin), { email: 'sam@bluven.test', name: 'Sam', roles: ['SALES'], password });
    await expect(login(db, { email: 'sam@bluven.test', password: 'x'.repeat(5000) })).rejects.toMatchObject({ message: 'Incorrect email or password.' });
    expect((await db.user.findUniqueOrThrow({ where: { email: 'sam@bluven.test' } })).failedLoginCount).toBe(0);
  });

  it('ends a session after 90 days however much it is used', async () => {
    await createUser(as(admin), { email: 'sam@bluven.test', name: 'Sam', roles: ['SALES'], password });
    const clock = new Clock();
    const { token } = await login(db, { email: 'sam@bluven.test', password, now: clock.current });
    for (let day = 5; day <= 85; day += 5) {
      clock.advanceDays(5);
      expect(await getSessionUser(db, token, clock.current), `day ${day}`).not.toBeNull();
    }
    const session = await db.session.findFirstOrThrow();
    expect(session.expiresAt.getTime()).toBeLessThanOrEqual(session.createdAt.getTime() + 90 * 86_400_000);
    clock.advanceDays(5); // day 90
    expect(await getSessionUser(db, token, clock.current)).toBeNull();
  });

  it('does not treat background requests of an open tab as use of the session', async () => {
    await createUser(as(admin), { email: 'sam@bluven.test', name: 'Sam', roles: ['SALES'], password });
    const clock = new Clock();
    const { token, expiresAt } = await login(db, { email: 'sam@bluven.test', password, now: clock.current });
    for (let day = 1; day <= 13; day++) {
      clock.advanceDays(1);
      expect(await getSessionUser(db, token, clock.current, { passive: true }), `day ${day}`).not.toBeNull();
    }
    const untouched = await db.session.findFirstOrThrow();
    expect(untouched.expiresAt.getTime()).toBe(expiresAt.getTime());
    expect(untouched.lastSeenAt.getTime()).toBe(untouched.createdAt.getTime());
    clock.advanceDays(1); // day 14: nobody was there, so it is over
    expect(await getSessionUser(db, token, clock.current, { passive: true })).toBeNull();
  });

  it('expires sessions and ends them when the account is deactivated', async () => {
    const { id } = await createUser(as(admin), { email: 'sam@bluven.test', name: 'Sam', roles: ['SALES'], password });
    const clock = new Clock();
    const { token } = await login(db, { email: 'sam@bluven.test', password, now: clock.current });
    clock.advanceDays(10);
    expect(await getSessionUser(db, token, clock.current)).not.toBeNull(); // renewed on use
    clock.advanceDays(13);
    expect(await getSessionUser(db, token, clock.current)).not.toBeNull();
    clock.advanceDays(15);
    expect(await getSessionUser(db, token, clock.current)).toBeNull();

    const second = await login(db, { email: 'sam@bluven.test', password });
    await updateUser(as(admin), { userId: id, name: 'Sam', roles: ['SALES'], isActive: false });
    expect(await getSessionUser(db, second.token)).toBeNull();
    await expect(login(db, { email: 'sam@bluven.test', password })).rejects.toMatchObject({ message: 'Incorrect email or password.' });
  });

  it('changes a password, clears the must-change flag and signs out other sessions', async () => {
    const { id } = await createUser(as(admin), { email: 'sam@bluven.test', name: 'Sam', roles: ['SALES'], password });
    const here = await login(db, { email: 'sam@bluven.test', password });
    const elsewhere = await login(db, { email: 'sam@bluven.test', password });
    const ctx = as({ id, name: 'Sam', email: 'sam@bluven.test', roles: ['SALES'] });
    await expect(changeOwnPassword(ctx, { current: 'wrong-wrong-wrong', next: 'Another-good-one-1' })).rejects.toMatchObject({ fieldErrors: { current: expect.any(String) } });
    await expect(changeOwnPassword(ctx, { current: password, next: 'short' })).rejects.toMatchObject({ fieldErrors: { next: expect.any(String) } });
    await changeOwnPassword(ctx, { current: password, next: 'Another-good-one-1', keepToken: here.token });
    expect((await db.user.findUniqueOrThrow({ where: { id } })).mustChangePassword).toBe(false);
    expect(await getSessionUser(db, here.token)).not.toBeNull();
    expect(await getSessionUser(db, elsewhere.token)).toBeNull();
    await login(db, { email: 'sam@bluven.test', password: 'Another-good-one-1' });

    // Guessing the current password from an unlocked screen is limited too.
    for (let i = 0; i < 5; i++) await changeOwnPassword(ctx, { current: `wrong-guess-${i}`, next: 'Yet-another-one-2' }).catch(() => undefined);
    await expect(changeOwnPassword(ctx, { current: 'Another-good-one-1', next: 'Yet-another-one-2' })).rejects.toMatchObject({ message: expect.stringContaining('Too many failed attempts') });

    await resetUserPassword(as(admin), { userId: id, password: 'Temporary-pass-9' });
    expect(await getSessionUser(db, here.token)).toBeNull();
    expect((await db.user.findUniqueOrThrow({ where: { id } })).mustChangePassword).toBe(true);
  });

  it('always keeps one active admin', async () => {
    await expect(updateUser(as(admin), { userId: admin.id, name: admin.name, roles: ['MANAGER'], isActive: true })).rejects.toMatchObject({ fieldErrors: { roles: expect.any(String) } });
    await expect(updateUser(as(admin), { userId: admin.id, name: admin.name, roles: ['ADMIN'], isActive: false })).rejects.toMatchObject({ code: 'validation' });
    const second = await makeUser(['ADMIN']);
    await updateUser(as(second), { userId: admin.id, name: admin.name, roles: ['MANAGER'], isActive: true });
    expect((await db.user.findUniqueOrThrow({ where: { id: admin.id } })).roles).toEqual(['MANAGER']);
  });
});

describe('intake tokens', () => {
  it('issues a token once, stores only its hash and honours a rotation overlap', async () => {
    const bluven = await source('bluven-website');
    const clock = new Clock();
    const first = await rotateIntakeToken(as(admin, clock), { sourceId: bluven.id });
    expect(first.token).toMatch(/^blv_[A-Za-z0-9_-]{43}$/);
    const row = await db.leadSource.findUniqueOrThrow({ where: { id: bluven.id } });
    expect(row.tokenHash).not.toBe(first.token);
    expect(row.tokenLast4).toBe(first.token.slice(-4));
    expect((await authenticateIntakeToken(db, first.token, clock.current))?.id).toBe(bluven.id);
    expect(await authenticateIntakeToken(db, 'blv_wrong', clock.current)).toBeNull();
    expect(await authenticateIntakeToken(db, '', clock.current)).toBeNull();

    const second = await rotateIntakeToken(as(admin, clock), { sourceId: bluven.id });
    // Both work during the overlap.
    expect(await authenticateIntakeToken(db, first.token, clock.current)).not.toBeNull();
    expect(await authenticateIntakeToken(db, second.token, clock.current)).not.toBeNull();
    clock.advanceDays(7.1);
    expect(await authenticateIntakeToken(db, first.token, clock.current)).toBeNull();
    expect(await authenticateIntakeToken(db, second.token, clock.current)).not.toBeNull();

    const third = await rotateIntakeToken(as(admin, clock), { sourceId: bluven.id });
    await revokePreviousIntakeToken(as(admin, clock), { sourceId: bluven.id });
    expect(await authenticateIntakeToken(db, second.token, clock.current)).toBeNull();
    expect(await authenticateIntakeToken(db, third.token, clock.current)).not.toBeNull();

    await updateLeadSource(as(admin), { sourceId: bluven.id, name: 'Bluven website', isActive: false });
    expect(await authenticateIntakeToken(db, third.token, clock.current)).toBeNull();
  });

  it('is managed by admins only and not offered for manual sources', async () => {
    const manager = await makeUser(['MANAGER']);
    const bluven = await source('bluven-website');
    await expect(rotateIntakeToken(as(manager), { sourceId: bluven.id })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(rotateIntakeToken(as(admin), { sourceId: (await source('manual')).id })).rejects.toMatchObject({ code: 'conflict' });
    const created = await createLeadSource(as(admin), { name: 'Solar Quotes Partner', kind: 'EXTERNAL' });
    expect((await db.leadSource.findUniqueOrThrow({ where: { id: created.id } })).key).toBe('solar-quotes-partner');
    await expect(updateLeadSource(as(admin), { sourceId: (await source('manual')).id, name: 'Manual entry', isActive: false })).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('configuration', () => {
  it('lets managers shape the handoff checklist through document types', async () => {
    const w = await makeWorld();
    const { orderId } = await orderAt(w, 'ASSIGNED');
    const keys = async () => (await getHandoffChecklist(db, orderId)).items.map((i) => i.key);
    expect(await keys()).toEqual(['address', 'contract', 'deposit', 'doc:electricity_bill', 'doc:install_location', 'doc:meter_box']);

    const roof = await createDocumentType(as(w.manager), { label: 'Roof photos', description: '', scope: 'PROPERTY', isRequiredForHandoff: true, retentionYears: 2, neverAutoDelete: false, sortOrder: 55, isActive: true });
    expect(await keys()).toEqual(['address', 'contract', 'deposit', 'doc:electricity_bill', 'doc:install_location', 'doc:roof_photos', 'doc:meter_box']);
    await updateDocumentType(as(w.manager), { typeId: roof.id, label: 'Roof photos', description: '', scope: 'PROPERTY', isRequiredForHandoff: false, retentionYears: 2, neverAutoDelete: false, sortOrder: 55, isActive: true });
    expect(await keys()).not.toContain('doc:roof_photos');

    const contractType = await db.documentType.findUniqueOrThrow({ where: { key: 'signed_contract' } });
    await expect(updateDocumentType(as(w.manager), { typeId: contractType.id, label: 'Signed contract', description: '', scope: 'ORDER', isRequiredForHandoff: false, retentionYears: null, neverAutoDelete: true, sortOrder: 10, isActive: false })).rejects.toMatchObject({ code: 'conflict' });
    await expect(createDocumentType(as(w.sam), { label: 'X', description: '', scope: 'ORDER', isRequiredForHandoff: false, retentionYears: null, neverAutoDelete: false, sortOrder: 1, isActive: true })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('lets managers add lost reasons', async () => {
    const manager = await makeUser(['MANAGER']);
    const { id } = await createLostReason(as(manager), { label: 'Moved interstate' });
    expect(await db.lostReason.findUniqueOrThrow({ where: { id } })).toMatchObject({ key: 'moved_interstate', isActive: true });
    await expect(createLostReason(as(manager), { label: 'Moved interstate' })).rejects.toMatchObject({ fieldErrors: { label: expect.any(String) } });
  });
});

describe('audit log', () => {
  it('cannot be changed or deleted, even directly in the database', async () => {
    await createLostReason(as(await makeUser(['MANAGER'])), { label: 'Test reason' });
    const row = await db.auditLog.findFirstOrThrow({ where: { action: 'lost_reason.create' } });
    await expect(db.auditLog.update({ where: { id: row.id }, data: { summary: 'tampered' } })).rejects.toThrow(/append-only/);
    await expect(db.auditLog.delete({ where: { id: row.id } })).rejects.toThrow(/append-only/);
    await expect(db.auditLog.deleteMany({})).rejects.toThrow(/append-only/);
    expect((await db.auditLog.findUniqueOrThrow({ where: { id: row.id } })).summary).toBe(row.summary);
  });

  it('records before and after values of an edit', async () => {
    const w = await makeWorld();
    const { orderId } = await orderAt(w, 'ASSIGNED');
    await updateCustomer(as(w.sam, w.clock), { orderId, firstName: 'Jane', lastName: 'Smith-Jones', notes: 'Prefers email.', phones: ['0412 345 678', '02 9123 4567'], emails: ['jane@example.com'] });
    const entry = await db.auditLog.findFirstOrThrow({ where: { action: 'customer.update', orderId } });
    expect(entry.before).toEqual({ lastName: 'Smith', notes: '', phones: ['0412 345 678'] });
    expect(entry.after).toEqual({ lastName: 'Smith-Jones', notes: 'Prefers email.', phones: ['0412 345 678', '02 9123 4567'] });
    expect(entry).toMatchObject({ actorId: w.sam.id, actorLabel: 'Sam Sales', userAgent: 'vitest' });
    // Saving the same values again writes nothing.
    await updateCustomer(as(w.sam, w.clock), { orderId, firstName: 'Jane', lastName: 'Smith-Jones', notes: 'Prefers email.', phones: ['0412 345 678', '02 9123 4567'], emails: ['jane@example.com'] });
    expect(await db.auditLog.count({ where: { action: 'customer.update', orderId } })).toBe(1);
    await expect(updateCustomer(as(w.sam, w.clock), { orderId, firstName: '', lastName: '', notes: '', phones: ['nope'], emails: ['bad'] })).rejects.toMatchObject({
      fieldErrors: { firstName: expect.any(String), 'phones.0': expect.any(String), 'emails.0': expect.any(String) },
    });
  });
});
