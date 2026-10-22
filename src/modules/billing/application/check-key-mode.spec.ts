import { AppConfig } from '../../../shared/config';
import { type Env } from '../../../shared/config/env';
import { FakeBillingProvider } from './billing.fakes';
import { CheckKeyMode } from './check-key-mode';

const config = (mode: 'test' | 'live') => new AppConfig({ LEMONSQUEEZY_MODE: mode } as Env);

describe('CheckKeyMode', () => {
  it('matches a test-mode key in test mode and flags a test key in live mode, or a live key in test mode', async () => {
    const provider = new FakeBillingProvider();
    provider.keyTestMode = true;
    await expect(new CheckKeyMode(provider, config('test')).execute()).resolves.toBe('match');
    await expect(new CheckKeyMode(provider, config('live')).execute()).resolves.toBe('mismatch');
    provider.keyTestMode = false;
    await expect(new CheckKeyMode(provider, config('test')).execute()).resolves.toBe('mismatch');
    await expect(new CheckKeyMode(provider, config('live')).execute()).resolves.toBe('match');
  });

  it('never throws: an unreachable provider or a missing flag is unknown', async () => {
    const provider = new FakeBillingProvider();
    provider.keyTestMode = null;
    await expect(new CheckKeyMode(provider, config('test')).execute()).resolves.toBe('unknown');
    provider.apiKeyTestMode = () => Promise.reject(new Error('Lemon Squeezy API returned HTTP 503'));
    await expect(new CheckKeyMode(provider, config('test')).execute()).resolves.toBe('unknown');
  });
});
