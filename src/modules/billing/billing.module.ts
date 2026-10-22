import { Inject, Module, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { AppConfig } from '../../shared/config';
import { JobExecutor } from '../../shared/jobs';
import { CheckKeyMode } from './application/check-key-mode';
import { CreateCheckout } from './application/create-checkout.usecase';
import { GetBudgetScopeQuery } from './application/get-budget-scope.query';
import { GetQuotaQuery } from './application/get-quota.query';
import { BILLING_PROVIDER } from './application/ports/billing-provider';
import { NOTIFICATION_PARSER } from './application/ports/billing-notification';
import { BILLING_REPOSITORY } from './application/ports/billing.repository';
import { BILLING_CLOCK } from './application/ports/clock';
import { QUOTA_REPOSITORY } from './application/ports/quota.repository';
import { ProcessBillingEvent } from './application/process-billing-event.handler';
import { ReceiveWebhook } from './application/receive-webhook.usecase';
import { ReservePath } from './application/reserve-path.usecase';
import { DrizzleBillingRepository } from './infrastructure/drizzle-billing.repository';
import { DrizzleQuotaRepository } from './infrastructure/drizzle-quota.repository';
import { LemonSqueezyNotificationParser } from './infrastructure/lemonsqueezy-notification.parser';
import { LemonSqueezyProvider } from './infrastructure/lemonsqueezy.provider';
import { BillingController } from './interface/billing.controller';
import { ACCOUNT_DATA } from '../../shared/common/account';
import { BillingAccountData } from './infrastructure/billing-account-data';

/** Billing (PRD-API §4, A12): Lemon Squeezy checkout and webhooks, entitlements and the credit ledger. */
@Module({
  controllers: [BillingController],
  providers: [
    GetQuotaQuery,
    GetBudgetScopeQuery,
    CreateCheckout,
    ReceiveWebhook,
    ProcessBillingEvent,
    ReservePath,
    CheckKeyMode,
    { provide: QUOTA_REPOSITORY, useClass: DrizzleQuotaRepository },
    { provide: BILLING_REPOSITORY, useClass: DrizzleBillingRepository },
    { provide: NOTIFICATION_PARSER, useClass: LemonSqueezyNotificationParser },
    { provide: BILLING_PROVIDER, inject: [AppConfig], useFactory: (config: AppConfig) => new LemonSqueezyProvider(config) },
    { provide: BILLING_CLOCK, useValue: () => new Date() },
    { provide: ACCOUNT_DATA.billing, useClass: BillingAccountData },
  ],
  exports: [GetQuotaQuery, GetBudgetScopeQuery, ReservePath, ACCOUNT_DATA.billing],
})
export class BillingModule implements OnModuleInit, OnApplicationBootstrap {
  constructor(
    @Inject(JobExecutor) private readonly executor: JobExecutor,
    @Inject(ProcessBillingEvent) private readonly processBillingEvent: ProcessBillingEvent,
    @Inject(CheckKeyMode) private readonly checkKeyMode: CheckKeyMode,
  ) {}

  onModuleInit(): void {
    this.executor.register(this.processBillingEvent);
  }

  onApplicationBootstrap(): void {
    // In the background: a slow or unreachable provider must not delay boot.
    void this.checkKeyMode.execute();
  }
}
