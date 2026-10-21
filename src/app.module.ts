import { Module } from '@nestjs/common';
import { IdentityModule } from './modules/identity/identity.module';
import { AuthKernelModule } from './shared/common/auth';
import { HealthModule } from './shared/common/health';
import { LoggingModule } from './shared/common/logging';
import { ProblemModule } from './shared/common/problem';
import { ConfigModule } from './shared/config';
import { DbModule } from './shared/db';

@Module({
  imports: [ConfigModule.forRoot(), LoggingModule, ProblemModule, AuthKernelModule, HealthModule, DbModule, IdentityModule],
})
export class AppModule {}
