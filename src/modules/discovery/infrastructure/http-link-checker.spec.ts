import { htmlToText } from './html-text';
import { type Fetched, HttpLinkChecker, publicLookup } from './http-link-checker';
import { isPublicAddress } from './public-address';

describe('SSRF guard', () => {
  it.each([
    '10.1.2.3',
    '127.0.0.1',
    '169.254.169.254',
    '172.20.0.1',
    '192.168.1.1',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    // Lead gate additions: IPv4-compatible, hex-mapped, and 6to4 embedding 127.0.0.1.
    '::127.0.0.1',
    '::ffff:7f00:1',
    '2002:7f00:1::',
  ])(
    'rejects the non-public address %s',
    (address) => {
      expect(isPublicAddress(address)).toBe(false);
    },
  );

  it.each(['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111', '::ffff:93.184.216.34'])('accepts the public address %s', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it('never connects to http, other ports, credentials, literal private IPs or local names', async () => {
    const lookups: string[] = [];
    const checker = new HttpLinkChecker((host, _options, callback) => {
      lookups.push(host);
      callback(new Error('no network in tests'), []);
    });
    for (const url of ['http://example.com/', 'https://example.com:8443/', 'https://u:p@example.com/', 'https://127.0.0.1/', 'https://[::1]/', 'https://169.254.169.254/latest/meta-data', 'https://localhost/', 'https://db.internal/']) {
      await expect(checker.check(url)).resolves.toEqual({ ok: false, status: null });
    }
    expect(lookups).toEqual([]);
    await expect(checker.fetchText('https://10.0.0.1/', 100)).resolves.toBeNull();
  });

  it.each(['https://[::1]/', 'https://0x7f.1/', 'https://2130706433/', 'https://[::ffff:7f00:1]/', 'https://[2002:7f00:1::]/'])(
    'refuses %s before connecting (WHATWG URL normalises it to a loopback literal)',
    async (url) => {
      let sent = 0;
      const checker = new HttpLinkChecker(publicLookup, () => {
        sent += 1;
        return Promise.reject(new Error('must not send'));
      });
      await expect(checker.check(url)).resolves.toEqual({ ok: false, status: null });
      expect(sent).toBe(0);
    },
  );

  it.each(['http://169.254.169.254/latest/meta-data', 'https://10.0.0.1/admin'])('stops at a redirect from a public URL to %s', async (target) => {
    const sent: string[] = [];
    const response = (status: number, location?: string): Fetched =>
      ({ status, contentType: 'text/html', response: { headers: location ? { location } : {}, destroy: () => undefined } }) as unknown as Fetched;
    const checker = new HttpLinkChecker(publicLookup, (url) => {
      sent.push(url.toString());
      return Promise.resolve(sent.length === 1 ? response(302, target) : response(200));
    });

    await expect(checker.check('https://public.example/start')).resolves.toEqual({ ok: false, status: null });
    expect(sent).toEqual(['https://public.example/start']);
  });

  it('follows a public redirect and gives up after 5 hops', async () => {
    let hops = 0;
    const checker = new HttpLinkChecker(publicLookup, () => {
      hops += 1;
      return Promise.resolve({ status: 301, contentType: '', response: { headers: { location: `/hop${hops}` }, destroy: () => undefined } } as unknown as Fetched);
    });
    await expect(checker.check('https://public.example/')).resolves.toEqual({ ok: false, status: null });
    expect(hops).toBe(6);
  });

  it('fails a lookup when any resolved address is private (checked at connect time)', (done) => {
    // localhost resolves without the network; it must be refused like any private answer.
    publicLookup('localhost', { all: true }, (err) => {
      expect(err?.message).toMatch(/non-public address/);
      done();
    });
  });
});

describe('htmlToText', () => {
  it('keeps readable text and drops scripts, styles, navigation and markup', () => {
    const html = `<html><head><title>x</title><style>p{}</style></head><body><nav>Menu</nav><h1>Hooks &amp; effects</h1>
      <p>Use <b>useEffect</b> for&nbsp;side effects.</p><script>alert(1)</script><!-- hidden --><p>Clean up &#8212; always.</p><footer>©</footer></body></html>`;
    expect(htmlToText(html, 1000)).toBe('Hooks & effects\nUse useEffect for side effects.\nClean up — always.');
    expect(htmlToText(html, 5)).toBe('Hooks');
  });
});
