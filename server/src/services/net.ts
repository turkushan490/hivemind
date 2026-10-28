import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/**
 * Guards for addresses that blocks call on their own (Webhook block, image URLs an image API hands back).
 * Cloud metadata, link-local and loopback addresses are always refused; other private addresses (your LAN:
 * Home Assistant, routers, NAS) are allowed unless BLOCK_PRIVATE_ADDRESSES=true, for HiveMind servers that
 * other people can use and that should not reach into the local network.
 */

const ALWAYS = new BlockList();
ALWAYS.addSubnet('0.0.0.0', 8, 'ipv4');
ALWAYS.addSubnet('127.0.0.0', 8, 'ipv4');
ALWAYS.addSubnet('169.254.0.0', 16, 'ipv4');
ALWAYS.addAddress('::', 'ipv6');
ALWAYS.addAddress('::1', 'ipv6');
ALWAYS.addSubnet('fe80::', 10, 'ipv6');

const PRIVATE = new BlockList();
PRIVATE.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE.addSubnet('192.168.0.0', 16, 'ipv4');
PRIVATE.addSubnet('100.64.0.0', 10, 'ipv4');
PRIVATE.addSubnet('fc00::', 7, 'ipv6');

export const blockPrivate = () => /^(1|true|yes)$/i.test(process.env.BLOCK_PRIVATE_ADDRESSES ?? '');

/** Why this IP may not be called, or undefined when it may. */
export function blockedReason(ip: string, allowPrivate = !blockPrivate()): string | undefined {
  const v4 = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  const addr = v4 ?? ip;
  const type = isIP(addr) === 6 ? 'ipv6' : 'ipv4';
  if (ALWAYS.check(addr, type)) return 'a loopback, link-local or cloud-metadata address';
  if (!allowPrivate && PRIVATE.check(addr, type)) return 'a private network address (BLOCK_PRIVATE_ADDRESSES is on)';
}

/** Throws a readable error when the URL is not http(s) or its host resolves to an address that may not be called. */
export async function checkUrl(url: string, what = 'This address'): Promise<URL> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`${what} is not a valid URL`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`${what} must be http(s)`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const ips = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (ips.length === 0) throw new Error(`Can't find the host ${u.host}`);
  for (const ip of ips) {
    const why = blockedReason(ip);
    if (why) throw new Error(`${what} (${u.host}) points to ${why}, which blocks may not call`);
  }
  return u;
}

/** The response body, refused once it grows past maxBytes (a huge answer can't fill the memory). */
export async function readCapped(res: Response, maxBytes: number, what = 'The answer'): Promise<Buffer> {
  const len = Number(res.headers.get('content-length'));
  if (len > maxBytes) throw new Error(`${what} is too big (${Math.round(len / 1e6)} MB, max ${Math.round(maxBytes / 1e6)} MB)`);
  if (!res.body) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > maxBytes) {
      await res.body.cancel().catch(() => {});
      throw new Error(`${what} is too big (over ${Math.round(maxBytes / 1e6)} MB)`);
    }
    parts.push(Buffer.from(chunk));
  }
  return Buffer.concat(parts);
}

/** An abort signal for a timeout, joined with an outer signal (cancel) when there is one. */
export const timeoutSignal = (ms: number, outer?: AbortSignal | null) => (outer ? AbortSignal.any([outer, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms));

/** Host only, for messages: never the path or query, which can hold a token (Discord webhooks, ?key=…). */
export const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return 'that address';
  }
};
