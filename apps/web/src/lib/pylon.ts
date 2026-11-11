import 'server-only';
import { ValidationError, getConfig } from '@bluven/core';
import { PylonApiError, PylonClient, type PylonApi, type PylonSyncResult } from '@bluven/integrations';

let client: PylonClient | null | undefined;

/** The Pylon API as this server is configured to reach it, or null when there is no token. */
export function pylonApi(): PylonApi | null {
  if (client === undefined) {
    const { apiBase, apiToken } = getConfig().pylon;
    client = apiToken ? new PylonClient({ apiBase, apiToken }) : null;
  }
  return client;
}

/** Runs something that talks to Pylon, and turns Pylon's failures into words a person can act on. */
export async function withPylon<T>(fn: (api: PylonApi | null) => Promise<T>): Promise<T> {
  try {
    return await fn(pylonApi());
  } catch (e) {
    if (!(e instanceof PylonApiError)) throw e;
    if (!pylonApi()) throw new ValidationError('The CRM is not connected to Pylon yet. An administrator can set it up under Administration, Pylon.');
    if (e.status === 401 || e.status === 403) throw new ValidationError('Pylon refused the CRM’s API token. Ask an administrator to check it under Administration, Pylon.');
    if (e.status === 404) throw new ValidationError(e.message);
    throw new ValidationError(`Pylon could not be read just now. Try again in a minute. (${e.message})`);
  }
}

/** One sentence on what a read of the Pylon project changed. */
export function describePylonSync(r: PylonSyncResult): string {
  const parts: string[] = [];
  if (r.quotesChanged) parts.push(`${r.quotesChanged} quote version${r.quotesChanged === 1 ? '' : 's'} added or updated`);
  if (r.signature) parts.push(r.signature.replace(/\.$/, ''));
  if (r.filled.length) parts.push(`property details filled in (${r.filled.join(', ')})`);
  if (!parts.length) return r.designs ? 'Everything is up to date with Pylon.' : 'The Pylon project has no priced design yet.';
  const text = parts.join('; ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}
