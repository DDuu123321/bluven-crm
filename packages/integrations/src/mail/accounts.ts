// Mailboxes: connecting one, keeping its tokens, and building the API to talk to it.
import type { Db, EmailAccount, EmailScope } from '@bluven/db';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, audit, can, getConfig, isManager, newId, nowOf, openSecret, requireUser, sealSecret, type Ctx } from '@bluven/core';
import { MailApiError, ZohoMailClient, exchangeZohoCode, refreshZohoToken, revokeZohoToken, type MailApi, type ZohoSettings } from '../zoho/client';

const TOKEN_PURPOSE = 'mail-token';
/** How far back the first read of a newly connected mailbox goes. */
export const FIRST_SYNC_DAYS = 14;

/** The Zoho application this server was given, or null when mail is not set up. */
export function zohoSettings(): ZohoSettings | null {
  const config = getConfig();
  if (!config.zoho.clientId || !config.zoho.clientSecret) return null;
  return { ...config.zoho, redirectUri: `${config.appUrl}/api/zoho/callback` };
}

function requireSettings(): ZohoSettings {
  const settings = zohoSettings();
  if (!settings) throw new ValidationError('E-mail is not set up on this server yet. An administrator has to add the Zoho client id and secret.');
  return settings;
}

const seal = (value: string, settings: ZohoSettings): string => sealSecret(value, settings.clientSecret, TOKEN_PURPOSE);
const open = (value: string, settings: ZohoSettings): string | null => openSecret(value, settings.clientSecret, TOKEN_PURPOSE);

/** Why connecting a mailbox did not work, for the page to say the right thing. */
export type ConnectProblem = 'refused' | 'settings' | 'wait' | 'incomplete';

export class MailboxConnectError extends ValidationError {
  constructor(
    message: string,
    readonly problem: ConnectProblem,
  ) {
    super(message);
  }
}

export interface MailDeps {
  fetchImpl?: typeof fetch;
  /** Builds the API for a mailbox. Tests pass a stand-in. */
  apiFor?: (account: Pick<EmailAccount, 'id' | 'providerAccountId'>) => MailApi;
  /** For the moment of connecting, when there is no stored mailbox yet. */
  apiWithToken?: (accessToken: string) => MailApi;
  /** Waited on before every request to the mail service. The background reading passes a pacer. */
  pace?: () => Promise<void>;
}

/**
 * The API for one stored mailbox. The access token (valid for an hour) is kept encrypted next to
 * the refresh token and renewed when it has run out or the provider refuses it.
 */
export function mailApiFor(db: Db, account: Pick<EmailAccount, 'id'>, deps: MailDeps = {}, now: () => Date = () => new Date()): MailApi {
  const settings = requireSettings();
  return new ZohoMailClient({
    mailUrl: settings.mailUrl,
    fetchImpl: deps.fetchImpl,
    pace: deps.pace,
    accessToken: async (force = false) => {
      const row = await db.emailAccount.findUnique({ where: { id: account.id }, select: { refreshTokenEnc: true, accessTokenEnc: true, accessTokenExpiresAt: true } });
      if (!row) throw new MailApiError('This mailbox is no longer connected.', null, false, true);
      if (!force && row.accessTokenEnc && row.accessTokenExpiresAt && row.accessTokenExpiresAt.getTime() - now().getTime() > 60_000) {
        const cached = open(row.accessTokenEnc, settings);
        if (cached) return cached;
      }
      const refresh = open(row.refreshTokenEnc, settings);
      // Sealed with a client secret that has since been replaced: nothing can be done but connect again.
      if (!refresh) throw new MailApiError('The stored permission for this mailbox can no longer be read.', null, false, true);
      const tokens = await refreshZohoToken(settings, refresh, deps.fetchImpl);
      await db.emailAccount.update({ where: { id: account.id }, data: { accessTokenEnc: seal(tokens.accessToken, settings), accessTokenExpiresAt: new Date(now().getTime() + tokens.expiresInSeconds * 1000) } });
      return tokens.accessToken;
    },
  });
}

/**
 * Finishes connecting a mailbox: the code Zoho passed back becomes tokens, the mailbox is looked
 * up, and both are stored for the signed-in user. Connecting again replaces the tokens and keeps
 * everything that was read before.
 */
export async function connectMailbox(ctx: Ctx, input: { code: string }, deps: MailDeps = {}): Promise<{ address: string }> {
  const actor = requireUser(ctx);
  if (!can(actor, 'orders.work')) throw new ForbiddenError('Only salespeople and managers connect a mailbox.');
  const settings = requireSettings();
  const now = nowOf(ctx);

  let tokens;
  try {
    tokens = await exchangeZohoCode(settings, input.code, deps.fetchImpl);
  } catch (e) {
    if (e instanceof MailApiError && e.authFailed) throw new MailboxConnectError('Zoho did not accept the sign-in. Please try connecting again.', 'refused');
    // Trying again does not help with these: the server's own Zoho settings are wrong, or Zoho wants us to wait.
    if (e instanceof MailApiError && e.setupFailed) throw new MailboxConnectError(`Zoho does not accept this server’s settings for it. Please tell your administrator: ${e.message}`, 'settings');
    if (e instanceof MailApiError && e.throttled) throw new MailboxConnectError('Zoho is asking us to wait before trying again. Please connect in ten minutes.', 'wait');
    throw e;
  }
  if (!tokens.refreshToken) throw new MailboxConnectError('Zoho did not grant lasting access. Please try connecting again and accept the request.', 'incomplete');

  const api = deps.apiWithToken ? deps.apiWithToken(tokens.accessToken) : new ZohoMailClient({ mailUrl: settings.mailUrl, fetchImpl: deps.fetchImpl, accessToken: async () => tokens.accessToken });
  const mailbox = (await api.listAccounts())[0];
  if (!mailbox) throw new ValidationError('That Zoho account has no mailbox the CRM can read.');

  const taken = await ctx.db.emailAccount.findFirst({ where: { address: mailbox.primaryAddress, userId: { not: actor.id } }, select: { id: true } });
  if (taken) throw new ConflictError(`The mailbox ${mailbox.primaryAddress} is already connected by another user.`);

  const existing = await ctx.db.emailAccount.findUnique({ where: { userId: actor.id } });
  const sameMailbox = existing?.providerAccountId === mailbox.accountId;
  const data = {
    address: mailbox.primaryAddress,
    addresses: mailbox.addresses,
    displayName: mailbox.displayName,
    providerAccountId: mailbox.accountId,
    refreshTokenEnc: seal(tokens.refreshToken, settings),
    accessTokenEnc: seal(tokens.accessToken, settings),
    accessTokenExpiresAt: new Date(now.getTime() + tokens.expiresInSeconds * 1000),
    connectedAt: now,
    needsReconnect: false,
    lastError: null,
    consecutiveFailures: 0,
  };
  if (existing) {
    // Another mailbox than before starts from scratch; the same one carries on where it was.
    await ctx.db.emailAccount.update({
      where: { id: existing.id },
      data: sameMailbox ? data : { ...data, folders: [], foldersCheckedAt: null, cursors: {}, filedFoldersAt: null, syncFrom: new Date(now.getTime() - FIRST_SYNC_DAYS * 86_400_000) },
    });
  } else {
    await ctx.db.emailAccount.create({ data: { id: newId('mbx'), userId: actor.id, ...data, syncFrom: new Date(now.getTime() - FIRST_SYNC_DAYS * 86_400_000) } });
  }
  await audit(ctx.db, ctx, {
    action: 'mail.connect',
    entityType: 'User',
    entityId: actor.id,
    summary: `${actor.name} connected the mailbox ${mailbox.primaryAddress}`,
    after: { address: mailbox.primaryAddress, reconnected: !!existing },
  });
  return { address: mailbox.primaryAddress };
}

/** Withdraws the permission at Zoho, as far as that is possible, and forgets the mailbox. Says whether Zoho confirmed. */
async function forget(db: Db, account: EmailAccount, deps: MailDeps): Promise<boolean> {
  const settings = zohoSettings();
  const refresh = settings ? open(account.refreshTokenEnc, settings) : null;
  const revoked = settings && refresh ? await revokeZohoToken(settings, refresh, deps.fetchImpl) : false;
  await db.emailAccount.delete({ where: { id: account.id } });
  return revoked;
}

/**
 * Disconnects a mailbox: the CRM stops reading it and forgets its tokens. Mail already on
 * customers' timelines stays. A user disconnects their own, whatever their role is now; a manager
 * can do it for anyone. `revoked` is false when Zoho did not confirm that the permission is gone
 * there too: the CRM no longer holds it either way, but the person can remove it in Zoho to be sure.
 */
export async function disconnectMailbox(ctx: Ctx, input: { userId?: string } = {}, deps: MailDeps = {}): Promise<{ revoked: boolean }> {
  const actor = requireUser(ctx);
  const userId = input.userId ?? actor.id;
  if (userId !== actor.id && !isManager(actor)) throw new ForbiddenError();
  const account = await ctx.db.emailAccount.findUnique({ where: { userId }, include: { user: { select: { name: true } } } });
  if (!account) return { revoked: true };
  const revoked = await forget(ctx.db, account, deps);
  await audit(ctx.db, ctx, {
    action: 'mail.disconnect',
    entityType: 'User',
    entityId: userId,
    summary: `${actor.name} disconnected the mailbox ${account.address}${userId === actor.id ? '' : ` of ${account.user.name}`}`,
    before: { address: account.address },
    meta: { revokedAtProvider: revoked },
  });
  return { revoked };
}

/**
 * Removes the mailboxes of people who may no longer have one: someone whose account was switched
 * off, or who no longer sells. Reading their mail stops at once and the permission is withdrawn.
 * Returns how many were removed.
 */
export async function removeOrphanedMailboxes(ctx: Ctx, deps: MailDeps = {}): Promise<number> {
  const accounts = await ctx.db.emailAccount.findMany({ include: { user: { select: { id: true, name: true, roles: true, isActive: true } } } });
  let removed = 0;
  for (const account of accounts) {
    if (account.user.isActive && can({ id: account.user.id, roles: account.user.roles }, 'orders.work')) continue;
    const revoked = await forget(ctx.db, account, deps);
    await audit(ctx.db, ctx, {
      action: 'mail.disconnect',
      entityType: 'User',
      entityId: account.userId,
      summary: `The mailbox ${account.address} of ${account.user.name} was disconnected: ${account.user.isActive ? 'they no longer have a sales or manager role' : 'their account is switched off'}`,
      before: { address: account.address },
      meta: { revokedAtProvider: revoked },
    });
    removed++;
  }
  return removed;
}

export const MAILBOX_SCOPE_LABEL: Record<EmailScope, string> = {
  OWN: 'Customers I work with',
  ALL: 'Every customer in the CRM',
};

/**
 * The owner's choice of how much of their mailbox the CRM keeps: mail with the customers they
 * work or worked with, or mail with every customer on record (for a mailbox several people
 * share). Nobody else can make this choice for them: it decides who gets to read their mail.
 */
export async function setMailboxScope(ctx: Ctx, input: { scope: string }): Promise<void> {
  const actor = requireUser(ctx);
  if (input.scope !== 'OWN' && input.scope !== 'ALL') throw new ValidationError('Choose one of the two.');
  const account = await ctx.db.emailAccount.findUnique({ where: { userId: actor.id } });
  if (!account) throw new NotFoundError('No mailbox is connected.');
  if (account.scope === input.scope) return;
  await ctx.db.emailAccount.update({ where: { id: account.id }, data: { scope: input.scope, scopeChangedAt: nowOf(ctx) } });
  await audit(ctx.db, ctx, {
    action: 'mail.scope',
    entityType: 'User',
    entityId: actor.id,
    summary: `${actor.name} changed what is kept from the mailbox ${account.address} to: ${MAILBOX_SCOPE_LABEL[input.scope]}`,
    before: { scope: account.scope },
    after: { scope: input.scope },
  });
}

export interface MailboxStatus {
  userId: string;
  userName: string;
  address: string;
  connectedAt: Date;
  lastOkAt: Date | null;
  lastError: string | null;
  needsReconnect: boolean;
  scope: EmailScope;
  /** Messages the CRM gave up on after several tries, newest first. They are still in the mailbox. */
  unreadable: { subject: string; at: Date | null; error: string }[];
}

/** What is recorded about a message that could not be read. */
export interface ProblemMessage {
  attempts: number;
  error: string;
  subject: string;
  /** When the message arrived. */
  at: string | null;
  /** When reading it first failed. */
  since: string | null;
}

export const MAX_READ_ATTEMPTS = 3;

export function problemsOf(account: Pick<EmailAccount, 'problemMessages'>): Record<string, ProblemMessage> {
  const raw = account.problemMessages;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, ProblemMessage> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const v = value as Partial<ProblemMessage>;
    out[id] = { attempts: typeof v.attempts === 'number' ? v.attempts : 1, error: typeof v.error === 'string' ? v.error : '', subject: typeof v.subject === 'string' ? v.subject : '', at: typeof v.at === 'string' ? v.at : null, since: typeof v.since === 'string' ? v.since : null };
  }
  return out;
}

const statusOf = (a: EmailAccount & { user: { name: string } }): MailboxStatus => ({
  userId: a.userId,
  userName: a.user.name,
  address: a.address,
  connectedAt: a.connectedAt,
  lastOkAt: a.lastOkAt,
  lastError: a.lastError,
  needsReconnect: a.needsReconnect,
  scope: a.scope,
  unreadable: Object.values(problemsOf(a))
    .filter((m) => m.attempts >= MAX_READ_ATTEMPTS)
    .map((m) => ({ subject: m.subject, at: m.at ? new Date(m.at) : null, error: m.error }))
    .sort((x, y) => (y.at?.getTime() ?? 0) - (x.at?.getTime() ?? 0)),
});

/** The signed-in user's own mailbox, if they have connected one. */
export async function getOwnMailbox(ctx: Ctx): Promise<MailboxStatus | null> {
  const actor = requireUser(ctx);
  const account = await ctx.db.emailAccount.findUnique({ where: { userId: actor.id }, include: { user: { select: { name: true } } } });
  return account ? statusOf(account) : null;
}

/** Every connected mailbox, for managers to see who is set up and whether reading works. */
export async function listMailboxes(ctx: Ctx): Promise<MailboxStatus[]> {
  const actor = requireUser(ctx);
  if (!isManager(actor)) throw new ForbiddenError();
  const accounts = await ctx.db.emailAccount.findMany({ include: { user: { select: { name: true } } }, orderBy: { address: 'asc' } });
  return accounts.map(statusOf);
}
