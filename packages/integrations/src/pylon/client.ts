// Client for the Pylon API (https://api.getpylon.com). JSON:API over HTTPS with a bearer token.
// Written from Pylon's developer documentation and checked against a live account. Fields are
// still read defensively: a value that is missing or of another type becomes null, never a crash.
import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebStream } from 'node:stream/web';
import { parseMoneyToCents } from '@bluven/core';
import { assertPublicHttpsUrl, type Resolver } from '../net';

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
  /** Every design of the project, oldest first as Pylon lists them. */
  designIds: string[];
  /** Where a person opens the project in Pylon. */
  inAppUrl: string;
  /** For showing a person which project this is before they link it. */
  customerName: string | null;
  siteAddress: string | null;
  /** What Pylon knows about the site. Empty values are null. */
  site: { nmi: string | null; retailer: string | null; phases: 'one' | 'three' | null };
}

export interface PylonDesign {
  id: string;
  projectId: string | null;
  /** The name the designer gave this option in Pylon. */
  title: string | null;
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
  /** A page of Pylon's event list, newest first. Pass the previous page's `next` to go further back. */
  listEvents(next?: string | null): Promise<PylonEventPage>;
}

/** Where a project lives in Pylon's own application. Events carry the same address. */
export const pylonProjectUrl = (projectId: string): string => `https://app.getpylon.com/library/${encodeURIComponent(projectId)}`;

/**
 * Reads a project id out of what a person pasted: the address of the project (or of one of its
 * designs) in Pylon, or the bare id. Returns null for anything else.
 */
export function parsePylonProjectRef(input: string): string | null {
  const text = input.trim();
  if (/^[A-Za-z0-9_-]{4,40}$/.test(text)) return text;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'app.getpylon.com') return null;
  const match = /^\/library\/([A-Za-z0-9_-]{4,40})(?:\/|$)/.exec(url.pathname);
  return match ? match[1]! : null;
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
  const address = obj(a.site_address);
  const site = obj(a.site_details);
  const designs = obj(obj(d.relationships).designs).data;
  const phases = str(site.power_phases)?.toLowerCase();
  return {
    id,
    referenceNumber: str(a.reference_number),
    isAccepted: acceptance.is_accepted === true,
    manuallySold: acceptance.manually_sold === true,
    hasEsignature: acceptance.latest_esignature === true,
    esignaturePdfUrl: str(acceptance.latest_esignature_pdf_url),
    latestSignedDesignId: relatedId(d.relationships, 'latest_signed_design'),
    primaryDesignId: relatedId(d.relationships, 'primary_design'),
    designIds: (Array.isArray(designs) ? designs : []).map((item) => str(obj(item).id)).filter((v): v is string => v !== null),
    inAppUrl: pylonProjectUrl(id),
    customerName: str(obj(a.customer_details).name),
    siteAddress: [str(address.line1), str(address.line2), str(address.city), str(address.state), str(address.zip)].filter(Boolean).join(', ') || null,
    site: { nmi: str(site.nmi), retailer: str(site.energy_retailer), phases: phases === 'one' || phases === 'three' ? phases : null },
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
    title: str(a.title),
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
  /** How host names of download links are resolved. For tests; defaults to the system resolver. */
  resolve?: Resolver;
}

/** A download link may send us on to its storage host, but not round in circles. */
const MAX_DOWNLOAD_REDIRECTS = 3;

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
        // The API has no reason to send us elsewhere, and the token must not follow a redirect.
        redirect: 'error',
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
    return parseDesign((await this.get(`/v1/solar_designs/${encodeURIComponent(id)}?fields[solar_designs]=title,summary,pricing,proposal_quote,project`)).data);
  }

  async download(url: string): Promise<Readable> {
    let target = url;
    for (let hop = 0; ; hop++) {
      // The link comes out of an API response. It must be HTTPS and lead to the public internet,
      // and so must every address it redirects to.
      try {
        await assertPublicHttpsUrl(target, this.opts.resolve);
      } catch (e) {
        throw new PylonApiError(e instanceof Error ? e.message : 'The download link was refused.', null, false);
      }
      let res: Response;
      try {
        // Pre-signed link: no credentials are sent.
        res = await this.fetchImpl(target, { signal: AbortSignal.timeout(60_000), redirect: 'manual' });
      } catch (e) {
        throw new PylonApiError(`Could not download the file from Pylon: ${e instanceof Error ? e.message : 'network error'}`, null, true);
      }
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        await res.body?.cancel().catch(() => undefined);
        if (!location || hop >= MAX_DOWNLOAD_REDIRECTS) throw new PylonApiError('The download link redirects too many times.', res.status, false);
        target = new URL(location, target).toString();
        continue;
      }
      if (!res.ok || !res.body) throw new PylonApiError(`Downloading the file from Pylon failed with status ${res.status}.`, res.status, res.status >= 500 || res.status === 429);
      return Readable.fromWeb(res.body as unknown as NodeWebStream<Uint8Array>);
    }
  }

  async listEvents(next?: string | null): Promise<PylonEventPage> {
    // Without the sort the list starts with the oldest event Pylon still has (30 days back),
    // 50 to a page, and nothing new would ever be reached.
    const body = await this.get(next ?? '/v1/events?sort=-created_at');
    return { events: Array.isArray(body.data) ? body.data : [], next: str(obj(body.links).next) };
  }
}
