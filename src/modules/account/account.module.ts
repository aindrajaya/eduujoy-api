import { Module } from '@nestjs/common';
import { AssessmentModule } from '../assessment/assessment.module';
import { BillingModule } from '../billing/billing.module';
import { CatalogModule } from '../catalog/catalog.module';
import { IdentityModule } from '../identity/identity.module';
import { ProgressModule } from '../progress/progress.module';
import { DeleteAccount } from './application/delete-account.usecase';
import { ExportAccount } from './application/export-account.usecase';
import { MeController } from './interface/me.controller';

/** Account (A13): personal data export and deletion, composed from each module's contributor. */
@Module({
  imports: [IdentityModule, AssessmentModule, ProgressModule, BillingModule, CatalogModule],
  controllers: [MeController],
  providers: [ExportAccount, DeleteAccount],
})
export class AccountModule {}
