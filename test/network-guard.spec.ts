import http from 'node:http';
import https from 'node:https';
import { BlockedNetworkError } from './setup-network';

describe('test network guard (setup-network.ts)', () => {
  it('blocks fetch to any non-local host', async () => {
    for (const url of ['https://api.lemonsqueezy.com/v1/checkouts', 'https://api.anthropic.com/v1/messages', 'https://generativelanguage.googleapis.com/x']) {
      await expect(fetch(url)).rejects.toBeInstanceOf(BlockedNetworkError);
    }
  });

  it('blocks node:http and node:https request and get to a non-local host', () => {
    expect(() => https.request('https://api.lemonsqueezy.com/v1/order-items')).toThrow(BlockedNetworkError);
    expect(() => https.request({ hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST' })).toThrow(BlockedNetworkError);
    expect(() => https.get(new URL('https://www.googleapis.com/youtube/v3/search'))).toThrow(BlockedNetworkError);
    expect(() => http.request({ host: 'example.com:80', path: '/' })).toThrow(BlockedNetworkError);
    expect(() => http.get('http://example.com/')).toThrow(BlockedNetworkError);
  });

  it('lets local test servers through', async () => {
    // Nothing listens on port 9, so a connection error (not the guard) proves the request was allowed.
    await expect(fetch('http://127.0.0.1:9/')).rejects.not.toBeInstanceOf(BlockedNetworkError);
    await new Promise<void>((resolve) => {
      const req = http.request({ hostname: '127.0.0.1', port: 9, path: '/' });
      req.on('error', () => {
        resolve();
      });
      req.end();
    });
  });
});
