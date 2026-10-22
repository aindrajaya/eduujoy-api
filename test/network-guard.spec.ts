import { BlockedNetworkError } from './setup-network';

describe('test network guard (setup-network.ts)', () => {
  it('blocks requests to any non-local host', async () => {
    for (const url of ['https://api.lemonsqueezy.com/v1/checkouts', 'https://api.anthropic.com/v1/messages', 'https://generativelanguage.googleapis.com/x']) {
      await expect(fetch(url)).rejects.toBeInstanceOf(BlockedNetworkError);
    }
  });

  it('lets local test servers through', async () => {
    // Nothing listens on this port, so a connection error (not the guard) proves the request was allowed.
    await expect(fetch('http://127.0.0.1:9/')).rejects.not.toBeInstanceOf(BlockedNetworkError);
  });
});
