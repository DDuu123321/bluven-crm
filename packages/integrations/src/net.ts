// Guard for fetching a file from an address that another system gave us.
//
// A download link comes out of an API response, not out of our own configuration. Followed
// blindly, a wrong or malicious link could make the server fetch from its own network (a cloud
// metadata address, a database's admin page) and file the answer away as a document somebody can
// open. So before fetching, and again on every redirect, the address must be HTTPS and must
// resolve to a public internet address.
import { lookup } from 'node:dns/promises';
import net from 'node:net';

function ipv4IsPublic(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number) as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return false; // "this" network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 168) return false; // private
  if (a === 192 && b === 0) return false; // protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a >= 224) return false; // multicast and reserved
  return true;
}

/** Whether an IP address is one on the public internet (not loopback, private, link-local…). */
export function isPublicAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return ipv4IsPublic(ip);
  if (!net.isIPv6(ip)) return false;
  const v = ip.toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v);
  if (mapped) return ipv4IsPublic(mapped[1]!);
  if (v === '::' || v === '::1') return false;
  if (/^f[cd]/.test(v)) return false; // unique local fc00::/7
  if (/^fe[89ab]/.test(v)) return false; // link-local fe80::/10
  if (v.startsWith('ff')) return false; // multicast
  return true;
}

export type Resolver = (hostname: string) => Promise<string[]>;

const systemResolver: Resolver = async (hostname) => (await lookup(hostname, { all: true })).map((a) => a.address);

/** Throws unless the URL is HTTPS and every address its host resolves to is public. */
export async function assertPublicHttpsUrl(url: string, resolve: Resolver = systemResolver): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('The link is not a valid address.');
  }
  if (parsed.protocol !== 'https:') throw new Error('Refusing to download over an insecure connection.');
  if (parsed.username || parsed.password) throw new Error('Refusing a link that carries a user name or password.');
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (!isPublicAddress(host)) throw new Error(`Refusing to download from ${host}: it is not a public address.`);
    return parsed;
  }
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new Error(`The host ${host} could not be resolved.`);
  }
  if (addresses.length === 0 || !addresses.every(isPublicAddress)) throw new Error(`Refusing to download from ${host}: it does not resolve to a public address.`);
  return parsed;
}
