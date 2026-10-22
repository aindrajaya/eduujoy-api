import { Inject, Injectable } from '@nestjs/common';
import { ACCOUNT_DATA, type AccountDataContributor } from '../../../shared/common/account';

export const EXPORT_FORMAT = 'eduujoy-export-v1';

/**
 * GET /v1/me/export (contract 0.6.0, PRD-API §12): every module's rows for this learner, as one JSON
 * document. Each contributor selects explicit columns for this user only, so no other learner's data and
 * no secret (password or token hashes, IP hashes, answer keys) can appear.
 */
@Injectable()
export class ExportAccount {
  private readonly contributors: AccountDataContributor[];

  constructor(
    @Inject(ACCOUNT_DATA.identity) identity: AccountDataContributor,
    @Inject(ACCOUNT_DATA.assessment) assessment: AccountDataContributor,
    @Inject(ACCOUNT_DATA.progress) progress: AccountDataContributor,
    @Inject(ACCOUNT_DATA.billing) billing: AccountDataContributor,
    @Inject(ACCOUNT_DATA.catalog) catalog: AccountDataContributor,
  ) {
    this.contributors = [identity, assessment, progress, billing, catalog];
  }

  async execute(userId: string): Promise<Record<string, unknown>> {
    const sections = await Promise.all(this.contributors.map(async (c) => [c.section, await c.export(userId)] as const));
    return { format: EXPORT_FORMAT, exportedAt: new Date().toISOString(), ...Object.fromEntries(sections) };
  }
}
