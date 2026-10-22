import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../../../shared/config';
import { BILLING_PROVIDER, type BillingProvider } from './ports/billing-provider';

export type KeyModeResult = 'match' | 'mismatch' | 'unknown';

/**
 * At startup, compares LEMONSQUEEZY_API_KEY's mode with LEMONSQUEEZY_MODE. A key for the other mode
 * creates checkouts but can't read that mode's order items, so paid credit packs would never credit.
 * Logs an error on mismatch; never blocks boot and never logs the key.
 */
@Injectable()
export class CheckKeyMode {
  private readonly logger = new Logger(CheckKeyMode.name);

  constructor(
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
    private readonly config: AppConfig,
  ) {}

  async execute(): Promise<KeyModeResult> {
    const mode = this.config.env.LEMONSQUEEZY_MODE;
    let keyTestMode: boolean | null;
    try {
      keyTestMode = await this.provider.apiKeyTestMode();
    } catch (error) {
      this.logger.warn({ err: error instanceof Error ? error : new Error(String(error)) }, 'Could not check the Lemon Squeezy API key mode');
      return 'unknown';
    }
    if (keyTestMode === null) {
      this.logger.warn({ mode }, 'Lemon Squeezy did not report the API key mode');
      return 'unknown';
    }
    const keyMode = keyTestMode ? 'test' : 'live';
    if (keyMode !== mode) {
      this.logger.error({ keyMode, mode }, `LEMONSQUEEZY_API_KEY is a ${keyMode}-mode key but LEMONSQUEEZY_MODE=${mode}: credit-pack orders cannot be read and will not credit`);
      return 'mismatch';
    }
    this.logger.log({ mode }, 'Lemon Squeezy API key mode matches LEMONSQUEEZY_MODE');
    return 'match';
  }
}
