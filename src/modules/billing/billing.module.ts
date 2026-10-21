import { Module } from '@nestjs/common';
import { GetQuotaQuery } from './application/get-quota.query';
import { BILLING_CLOCK } from './application/ports/clock';
import { QUOTA_REPOSITORY } from './application/ports/quota.repository';
import { DrizzleQuotaRepository } from './infrastructure/drizzle-quota.repository';

@Module({
  providers: [
    GetQuotaQuery,
    { provide: QUOTA_REPOSITORY, useClass: DrizzleQuotaRepository },
    { provide: BILLING_CLOCK, useValue: () => new Date() },
  ],
  exports: [GetQuotaQuery],
})
export class BillingModule {}
