// Client for the Pylon API (https://api.getpylon.com). JSON:API over HTTPS with a bearer token.
// Written from Pylon's developer documentation. Every field is read defensively because the
// integration has not been exercised against a live Pylon account yet.
import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebStream } from 'node:stream/web';
import { parseMoneyToCents } from '@bluven/core';

export class PylonApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    /** Worth trying again later: network trouble, rate limiting, server errors, or a missing token. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'PylonApiError';
  }
}

export interface PylonProject {
  id: string;
  referenceNumber: string | null;
  isAccepted: boolean;
  manuallySold: boolean;
  hasEsignature: boolean;
  /** Pre-signed link to the signed PDF. Valid for one hour from the response. */
  esignaturePdfUrl: string | null;
  latestSignedDesignId: string | null;
  primaryDesignId: string | null;
}

export interface PylonDesign {
  id: string;
  projectId: string | null;
  dcOutputKw: number | null;
  storageKwh: number | null;
  totalCents: number | null;
  currency: string;
  depositCents: number | null;
  webProposalUrl: string | null;
  pdfProposalUrl: string | null;
}

export interface PylonEventPage {
  events: unknown[];
  next: string | null;
}

/** What the event handlers need from Pylon. Tests supply a stub. */
export interface PylonApi {
  getSolarProject(id: string): Promise<PylonProject>;
  findProjectByReference(reference: string): Promise<PylonProject | null>;
  getSolarDesign(id: string): Promise<PylonDesign>;
  /** Opens a download of a file Pylon handed us a link to (the signed proposal PDF). */
  download(url: string): Promise<Readable>;
  listEvents(next?: string | null): Promise<PylonEventPage>;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : null);
const relatedId = (relationships: unknown, name: string): string | null => str(obj(obj(obj(relationships)[name]).data).id);

export function parseProject(data: unknown): PylonProject {
  const d = obj(data);
  const id = str(d.id);
  if (!id) throw new PylonApiError('Pylon returned a project without an id.', null, false);
  const a = obj(d.attributes);
  const acceptance = obj(a.acceptance);
  return {
    id,
    referenceNumber: str(a.reference_number),
    isAccepted: acceptance.is_accepted === true,
    manuallySold: acceptance.manually_sold === true,
    hasEsignature: acceptance.latest_esignature === true,
    esignaturePdfUrl: str(acceptance.latest_esignature_pdf_url),
    latestSignedDesignId: relatedId(d.relationships, 'latest_signed_design'),
    primaryDesignId: relatedId(d.relationships, 'primary_design'),
  };
}

export function parseDesign(data: unknown): PylonDesign {
  const d = obj(data);
  const id = str(d.id);
  if (!id) throw new PylonApiError('Pylon returned a design without an id.', null, false);
  const a = obj(d.attributes);
  const summary = obj(a.summary);
  const pricing = obj(a.pricing);
  const quote = obj(a.proposal_quote);
  const total = num(pricing.total);
  const deposit = str(quote.deposit_amount_formatted);
  return {
    id,
    projectId: relatedId(d.relationships, 'project') ?? relatedId(d.relationships, 'solar_project'),
    dcOutputKw: num(summary.dc_output_kw),
    storageKwh: num(summary.storage_kwh),
    // Pylon reports the total in cents.
    totalCents: total === null ? null : Math.round(total),
    currency: (str(pricing.currency) ?? str(quote.currency) ?? 'AUD').toUpperCase(),
    depositCents: deposit ? parseMoneyToCents(deposit.replace(/[^\d.,]/g, '')) : null,
    webProposalUrl: str(summary.web_proposal_url),
    pdfProposalUrl: str(summary.pdf_proposal_url),
  };
}

export interface PylonClientOptions {
  apiBase: string;
  apiToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class PylonClient implements PylonApi {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: PylonClientOptions) {
    this.base = opts.apiBase.replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  private async get(pathOrUrl: string): Promise<Json> {
    if (!this.opts.apiToken) throw new PylonApiError('The Pylon API token is not configured.', null, true);
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${this.base}${pathOrUrl}`;
    // Never send the token anywhere but the configured API host.
    if (new URL(url).origin !== new URL(this.base).origin) throw new PylonApiError(`Refusing to call ${new URL(url).origin} with the Pylon token.`, null, false);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { Authorization: `Bearer ${this.opts.apiToken}`, Accept: 'application/vnd.api+json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new PylonApiError(`Could not reach Pylon: ${e instanceof Error ? e.message : 'network error'}`, null, true);
    }
    if (!res.ok) {
      const retryable = res.status === 401 || res.status === 403 || res.status === 408 || res.status === 429 || res.status >= 500;
      throw new PylonApiError(`Pylon answered ${res.status} for ${new URL(url).pathname}`, res.status, retryable);
    }
    try {
      return obj(await res.json());
    } catch {
      throw new PylonApiError('Pylon returned a response that is not JSON.', res.status, true);
    }
  }

  async getSolarProject(id: string): Promise<PylonProject> {
    return parseProject((await this.get(`/v1/solar_projects/${encodeURIComponent(id)}`)).data);
  }

  async findProjectByReference(reference: string): Promise<PylonProject | null> {
    const body = await this.get(`/v1/solar_projects?filter[reference_number]=${encodeURIComponent(reference)}`);
    const first = Array.isArray(body.data) ? body.data[0] : null;
    return first ? parseProject(first) : null;
  }

  async getSolarDesign(id: string): Promise<PylonDesign> {
    // The fields parameter is mandatory on design endpoints.
    return parseDesign((await this.get(`/v1/solar_designs/${encodeURIComponent(id)}?fields[solar_designs]=summary,pricing,proposal_quote`)).data);
  }

  async download(url: string): Promise<Readable> {
    if (new URL(url).protocol !== 'https:') throw new PylonApiError('Refusing to download over an insecure connection.', null, false);
    let res: Response;
    try {
      // Pre-signed link: no credentials are sent.
      res = await this.fetchImpl(url, { signal: AbortSignal.timeout(60_000) });
    } catch (e) {
      throw new PylonApiError(`Could not download the file from Pylon: ${e instanceof Error ? e.message : 'network error'}`, null, true);
    }
    if (!res.ok || !res.body) throw new PylonApiError(`Downloading the file from Pylon failed with status ${res.status}.`, res.status, res.status >= 500 || res.status === 429);
    return Readable.fromWeb(res.body as unknown as NodeWebStream<Uint8Array>);
  }

  async listEvents(next?: string | null): Promise<PylonEventPage> {
    const body = await this.get(next ?? '/v1/events');
    return { events: Array.isArray(body.data) ? body.data : [], next: str(obj(body.links).next) };
  }
}
