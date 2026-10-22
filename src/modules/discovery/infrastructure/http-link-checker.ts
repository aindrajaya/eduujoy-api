import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { type IncomingMessage } from 'node:http';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { type LinkCheck, type LinkChecker } from '../application/ports/link-checker';
import { isLiveStatus } from '../domain';
import { htmlToText } from './html-text';
import { isPublicAddress } from './public-address';

const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
const MAX_BYTES = 2_000_000;
const USER_AGENT = 'Mozilla/5.0 (compatible; EduujoyBot/1.0; +https://eduujoy.aindrajaya.my.id)';
const TEXT_TYPES = /^(text\/html|application\/xhtml\+xml|text\/plain)\b/i;

export class BlockedAddressError extends Error {
  override name = 'BlockedAddressError';
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * Resolves like dns.lookup, but fails when any address is not public. Used as the socket's `lookup`,
 * so the check covers the address actually connected to (no DNS rebinding between check and connect).
 */
export function publicLookup(hostname: string, options: { all?: boolean; family?: number }, callback: LookupCallback): void {
  dnsLookup(hostname, { all: true, family: options.family ?? 0 }, (err, addresses) => {
    if (err) {
      callback(err, []);
    } else if (addresses.length === 0 || addresses.some((a) => !isPublicAddress(a.address))) {
      callback(Object.assign(new BlockedAddressError(`${hostname} resolves to a non-public address`), { code: 'EBLOCKED' }), []);
    } else if (options.all) {
      callback(null, addresses);
    } else {
      const [first] = addresses as [LookupAddress];
      callback(null, first.address, first.family);
    }
  });
}

export interface Fetched {
  status: number;
  contentType: string;
  response: IncomingMessage;
}

/**
 * HTTPS-only GET with redirects followed by hand (at most 5, each re-checked), a 10 s budget per URL
 * (PRD-API §5), and an SSRF guard: literal and resolved addresses must be public.
 */
export class HttpLinkChecker implements LinkChecker {
  /** `send` makes one request (no redirects); tests replace it to script redirects without a TLS server. */
  constructor(
    private readonly lookup: typeof publicLookup = publicLookup,
    private readonly send?: (url: URL, signal: AbortSignal) => Promise<Fetched>,
  ) {}

  async check(url: string, signal?: AbortSignal): Promise<LinkCheck> {
    try {
      const fetched = await this.get(url, signal);
      fetched.response.destroy();
      return { ok: isLiveStatus(fetched.status), status: fetched.status };
    } catch {
      return { ok: false, status: null };
    }
  }

  async fetchText(url: string, maxChars: number, signal?: AbortSignal): Promise<string | null> {
    let fetched: Fetched;
    try {
      fetched = await this.get(url, signal);
    } catch {
      return null;
    }
    if (!isLiveStatus(fetched.status) || !TEXT_TYPES.test(fetched.contentType)) {
      fetched.response.destroy();
      return null;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of fetched.response) {
        const buffer = chunk as Buffer;
        size += buffer.length;
        chunks.push(buffer);
        if (size >= MAX_BYTES) break;
      }
    } catch {
      return null;
    } finally {
      fetched.response.destroy();
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    const text = fetched.contentType.startsWith('text/plain') ? raw.slice(0, maxChars).trim() : htmlToText(raw, maxChars);
    return text || null;
  }

  private async get(start: string, signal?: AbortSignal): Promise<Fetched> {
    const deadline = AbortSignal.timeout(TIMEOUT_MS);
    const abort = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let url = new URL(start);
    for (let hop = 0; ; hop += 1) {
      this.assertAllowed(url);
      const fetched = await (this.send ?? this.once.bind(this))(url, abort);
      const location = fetched.response.headers.location;
      if (fetched.status >= 300 && fetched.status < 400 && location) {
        fetched.response.destroy();
        if (hop >= MAX_REDIRECTS) throw new Error('Too many redirects');
        url = new URL(location, url);
        continue;
      }
      return fetched;
    }
  }

  private assertAllowed(url: URL): void {
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new BlockedAddressError('Only https on port 443');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) && !isPublicAddress(host)) throw new BlockedAddressError('Non-public address');
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) throw new BlockedAddressError('Local host name');
  }

  private once(url: URL, signal: AbortSignal): Promise<Fetched> {
    return new Promise((resolve, reject) => {
      const req = request(
        url,
        {
          method: 'GET',
          signal,
          lookup: this.lookup as never,
          headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5', 'accept-language': 'en' },
        },
        (response) => {
          resolve({ status: response.statusCode ?? 0, contentType: response.headers['content-type'] ?? '', response });
        },
      );
      req.on('error', reject);
      req.end();
    });
  }
}
