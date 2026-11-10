// Configuration: lead sources and their intake tokens, document types (the handoff checklist)
// and lost reasons.
import { createHash, randomBytes } from 'node:crypto';
import type { Db, DocScope, LeadSource, LeadSourceKind } from '@bluven/db';
import { inTx, nowOf, type Ctx } from '../context';
import { can } from '../domain';
import { ConflictError, FieldErrors, ForbiddenError, NotFoundError, ValidationError } from '../errors';
import { newId } from '../ids';
import { audit, diff } from './audit';

function requireCap(ctx: Ctx, capability: Parameters<typeof can>[1]): void {
  if (ctx.actor.kind !== 'user' || !can(ctx.actor, capability)) throw new ForbiddenError();
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

// ---------------------------------------------------------------------------
// Lead sources and intake tokens
// ---------------------------------------------------------------------------

const TOKEN_OVERLAP_MS = 7 * 24 * 60 * 60 * 1000;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createLeadSource(ctx: Ctx, input: { name: string; kind: string }): Promise<{ id: string }> {
  requireCap(ctx, 'admin.leadSources');
  const errors = new FieldErrors();
  const name = input.name.trim();
  if (!name) errors.add('name', 'Enter a name.');
  if (name.length > 80) errors.add('name', 'Use at most 80 characters.');
  const kind = (['BLUVEN', 'EXTERNAL', 'CSV'] as LeadSourceKind[]).find((k) => k === input.kind);
  if (!kind) errors.add('kind', 'Choose a type.');
  errors.throwIfAny();
  const key = slug(name).replace(/_/g, '-');
  if (!key) throw new ValidationError('Use letters or digits in the name.', { name: 'Use letters or digits.' });
  if (await ctx.db.leadSource.findUnique({ where: { key } })) throw new ValidationError('A source with this name already exists.', { name: 'Already in use.' });
  const id = newId('src');
  await inTx(ctx.db, async (tx) => {
    await tx.leadSource.create({ data: { id, key, name, kind: kind! } });
    await audit(tx, ctx, { action: 'lead_source.create', entityType: 'LeadSource', entityId: id, summary: `Created lead source ${name}`, after: { key, name, kind } });
  });
  return { id };
}

export async function updateLeadSource(ctx: Ctx, input: { sourceId: string; name: string; isActive: boolean }): Promise<void> {
  requireCap(ctx, 'admin.leadSources');
  const name = input.name.trim();
  if (!name) throw new ValidationError('Enter a name.', { name: 'Enter a name.' });
  await inTx(ctx.db, async (tx) => {
    const source = await tx.leadSource.findUnique({ where: { id: input.sourceId } });
    if (!source) throw new NotFoundError('Lead source not found.');
    if (source.kind === 'MANUAL' && !input.isActive) throw new ConflictError('Manual entry cannot be switched off.');
    const change = diff({ name: source.name, isActive: source.isActive }, { name, isActive: input.isActive });
    if (!change) return;
    await tx.leadSource.update({ where: { id: source.id }, data: { name, isActive: input.isActive } });
    await audit(tx, ctx, { action: 'lead_source.update', entityType: 'LeadSource', entityId: source.id, summary: `Updated lead source ${source.key}`, ...change });
  });
}

/**
 * Issues a new intake token and returns it once: only its hash is stored. The previous token
 * keeps working for seven days so the sending system can switch over without a gap.
 */
export async function rotateIntakeToken(ctx: Ctx, input: { sourceId: string }): Promise<{ token: string }> {
  requireCap(ctx, 'admin.leadSources');
  const token = `blv_${randomBytes(32).toString('base64url')}`;
  await inTx(ctx.db, async (tx) => {
    const source = await tx.leadSource.findUnique({ where: { id: input.sourceId } });
    if (!source) throw new NotFoundError('Lead source not found.');
    if (source.kind === 'MANUAL' || source.kind === 'CSV') throw new ConflictError('This source does not receive leads over the API.');
    const now = nowOf(ctx);
    await tx.leadSource.update({
      where: { id: source.id },
      data: {
        tokenHash: hashToken(token),
        tokenLast4: token.slice(-4),
        tokenCreatedAt: now,
        prevTokenHash: source.tokenHash,
        prevTokenExpiresAt: source.tokenHash ? new Date(now.getTime() + TOKEN_OVERLAP_MS) : null,
      },
    });
    await audit(tx, ctx, {
      action: 'lead_source.token_rotate',
      entityType: 'LeadSource',
      entityId: source.id,
      summary: `${source.tokenHash ? 'Rotated' : 'Issued'} intake token for ${source.name}`,
      meta: { last4: token.slice(-4), previousTokenValidFor: source.tokenHash ? '7 days' : null },
    });
  });
  return { token };
}

/** Ends the grace period of the previous token immediately. */
export async function revokePreviousIntakeToken(ctx: Ctx, input: { sourceId: string }): Promise<void> {
  requireCap(ctx, 'admin.leadSources');
  await inTx(ctx.db, async (tx) => {
    const source = await tx.leadSource.findUnique({ where: { id: input.sourceId } });
    if (!source) throw new NotFoundError('Lead source not found.');
    if (!source.prevTokenHash) return;
    await tx.leadSource.update({ where: { id: source.id }, data: { prevTokenHash: null, prevTokenExpiresAt: null } });
    await audit(tx, ctx, { action: 'lead_source.token_revoke_previous', entityType: 'LeadSource', entityId: source.id, summary: `Revoked previous intake token for ${source.name}` });
  });
}

/** Resolves an intake API token to its active source, or null. */
export async function authenticateIntakeToken(db: Db, token: string, now: Date = new Date()): Promise<LeadSource | null> {
  if (!token || token.length > 200) return null;
  const hash = hashToken(token);
  const source = await db.leadSource.findFirst({
    where: { isActive: true, OR: [{ tokenHash: hash }, { prevTokenHash: hash, prevTokenExpiresAt: { gt: now } }] },
  });
  return source;
}

// ---------------------------------------------------------------------------
// Document types
// ---------------------------------------------------------------------------

export interface DocumentTypeInput {
  label: string;
  description: string;
  scope: string;
  isRequiredForHandoff: boolean;
  retentionYears: number | null;
  neverAutoDelete: boolean;
  sortOrder: number;
  isActive: boolean;
}

function cleanDocType(input: DocumentTypeInput, errors: FieldErrors) {
  const label = input.label.trim();
  if (!label) errors.add('label', 'Enter a name.');
  if (label.length > 80) errors.add('label', 'Use at most 80 characters.');
  const scope = (['PROPERTY', 'ORDER'] as DocScope[]).find((s) => s === input.scope);
  if (!scope) errors.add('scope', 'Choose whether the files belong to the property or to the order.');
  if (input.retentionYears !== null && !(Number.isInteger(input.retentionYears) && input.retentionYears >= 1 && input.retentionYears <= 50)) {
    errors.add('retentionYears', 'Enter a whole number of years between 1 and 50, or leave it empty.');
  }
  return {
    label,
    description: input.description.trim().slice(0, 300),
    scope: scope!,
    isRequiredForHandoff: input.isRequiredForHandoff,
    retentionYears: input.retentionYears,
    neverAutoDelete: input.neverAutoDelete,
    sortOrder: Number.isFinite(input.sortOrder) ? Math.trunc(input.sortOrder) : 0,
    isActive: input.isActive,
  };
}

export async function createDocumentType(ctx: Ctx, input: DocumentTypeInput): Promise<{ id: string }> {
  requireCap(ctx, 'config.manage');
  const errors = new FieldErrors();
  const data = cleanDocType(input, errors);
  errors.throwIfAny();
  const key = slug(data.label);
  if (!key) throw new ValidationError('Use letters or digits in the name.', { label: 'Use letters or digits.' });
  if (await ctx.db.documentType.findUnique({ where: { key } })) throw new ValidationError('A document type with this name already exists.', { label: 'Already in use.' });
  const id = newId('dty');
  await inTx(ctx.db, async (tx) => {
    await tx.documentType.create({ data: { id, key, ...data } });
    await audit(tx, ctx, { action: 'document_type.create', entityType: 'DocumentType', entityId: id, summary: `Created document type ${data.label}`, after: { key, ...data } });
  });
  return { id };
}

export async function updateDocumentType(ctx: Ctx, input: { typeId: string } & DocumentTypeInput): Promise<void> {
  requireCap(ctx, 'config.manage');
  const errors = new FieldErrors();
  const data = cleanDocType(input, errors);
  errors.throwIfAny();
  await inTx(ctx.db, async (tx) => {
    const type = await tx.documentType.findUnique({ where: { id: input.typeId } });
    if (!type) throw new NotFoundError('Document type not found.');
    if (type.isSystem) {
      // Built-in types back the contract, deposit and quote features: only cosmetic changes.
      if (!data.isActive) throw new ConflictError('Built-in document types cannot be switched off.');
      data.scope = type.scope;
      data.isRequiredForHandoff = type.isRequiredForHandoff;
    } else if (data.scope !== type.scope && (await tx.document.count({ where: { typeId: type.id } })) > 0) {
      throw new ConflictError('Files already use this type, so it cannot move between property and order.');
    }
    const change = diff(type as unknown as Record<string, unknown>, data as unknown as Record<string, unknown>);
    if (!change) return;
    await tx.documentType.update({ where: { id: type.id }, data });
    await audit(tx, ctx, { action: 'document_type.update', entityType: 'DocumentType', entityId: type.id, summary: `Updated document type ${type.key}`, ...change });
  });
}

// ---------------------------------------------------------------------------
// Lost reasons
// ---------------------------------------------------------------------------

export async function createLostReason(ctx: Ctx, input: { label: string }): Promise<{ id: string }> {
  requireCap(ctx, 'config.manage');
  const label = input.label.trim();
  if (!label) throw new ValidationError('Enter a reason.', { label: 'Enter a reason.' });
  if (label.length > 100) throw new ValidationError('Use at most 100 characters.', { label: 'Use at most 100 characters.' });
  const key = slug(label);
  if (!key) throw new ValidationError('Use letters or digits.', { label: 'Use letters or digits.' });
  if (await ctx.db.lostReason.findUnique({ where: { key } })) throw new ValidationError('This reason already exists.', { label: 'Already in use.' });
  const id = newId('lrs');
  await inTx(ctx.db, async (tx) => {
    const last = await tx.lostReason.findFirst({ orderBy: { sortOrder: 'desc' }, select: { sortOrder: true } });
    await tx.lostReason.create({ data: { id, key, label, sortOrder: (last?.sortOrder ?? 0) + 10 } });
    await audit(tx, ctx, { action: 'lost_reason.create', entityType: 'LostReason', entityId: id, summary: `Created lost reason “${label}”`, after: { key, label } });
  });
  return { id };
}

export async function updateLostReason(ctx: Ctx, input: { reasonId: string; label: string; isActive: boolean; sortOrder: number }): Promise<void> {
  requireCap(ctx, 'config.manage');
  const label = input.label.trim();
  if (!label) throw new ValidationError('Enter a reason.', { label: 'Enter a reason.' });
  await inTx(ctx.db, async (tx) => {
    const reason = await tx.lostReason.findUnique({ where: { id: input.reasonId } });
    if (!reason) throw new NotFoundError('Lost reason not found.');
    const next = { label: label.slice(0, 100), isActive: input.isActive, sortOrder: Number.isFinite(input.sortOrder) ? Math.trunc(input.sortOrder) : reason.sortOrder };
    const change = diff({ label: reason.label, isActive: reason.isActive, sortOrder: reason.sortOrder }, next);
    if (!change) return;
    await tx.lostReason.update({ where: { id: reason.id }, data: next });
    await audit(tx, ctx, { action: 'lost_reason.update', entityType: 'LostReason', entityId: reason.id, summary: `Updated lost reason ${reason.key}`, ...change });
  });
}
