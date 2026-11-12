// Mailboxes: connecting one, keeping its tokens, and building the API to talk to it.
import type { Db, EmailAccount } from '@bluven/db';
import { ConflictError, ForbiddenError, ValidationError, audit, can, getConfig, isManager, newId, nowOf, openSecret, requireUser, sealSecret, type Ctx } from '@bluven/core';
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

export interface MailDeps {
  fetchImpl?: typeof fetch;
  /** Builds the API for a mailbox. Tests pass a stand-in. */
  apiFor?: (account: Pick<EmailAccount, 'id' | 'providerAccountId'>) => MailApi;
  /** For the moment of connecting, when there is no stored mailbox yet. */
  apiWithToken?: (accessToken: string) => MailApi;
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
    if (e instanceof MailApiError && e.authFailed) throw new ValidationError('Zoho did not accept the sign-in. Please try connecting again.');
    throw e;
  }
  if (!tokens.refreshToken) throw new ValidationError('Zoho did not grant lasting access. Please try connecting again and accept the request.');

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

/**
 * Disconnects a mailbox: the CRM stops reading it and forgets its tokens. Mail already on
 * customers' timelines stays. A user disconnects their own; a manager can do it for anyone.
 */
export async function disconnectMailbox(ctx: Ctx, input: { userId?: string } = {}, deps: MailDeps = {}): Promise<void> {
  const actor = requireUser(ctx);
  const userId = input.userId ?? actor.id;
  if (userId !== actor.id && !isManager(actor)) throw new ForbiddenError();
  const account = await ctx.db.emailAccount.findUnique({ where: { userId }, include: { user: { select: { name: true } } } });
  if (!account) return;
  const settings = zohoSettings();
  if (settings) {
    const refresh = open(account.refreshTokenEnc, settings);
    if (refresh) await revokeZohoToken(settings, refresh, deps.fetchImpl);
  }
  await ctx.db.emailAccount.delete({ where: { id: account.id } });
  await audit(ctx.db, ctx, {
    action: 'mail.disconnect',
    entityType: 'User',
    entityId: userId,
    summary: `${actor.name} disconnected the mailbox ${account.address}${userId === actor.id ? '' : ` of ${account.user.name}`}`,
    before: { address: account.address },
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
}

const statusOf = (a: EmailAccount & { user: { name: string } }): MailboxStatus => ({ userId: a.userId, userName: a.user.name, address: a.address, connectedAt: a.connectedAt, lastOkAt: a.lastOkAt, lastError: a.lastError, needsReconnect: a.needsReconnect });

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
