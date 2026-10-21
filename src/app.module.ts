import { Module } from '@nestjs/common';
import { HealthModule } from './shared/common/health';
import { LoggingModule } from './shared/common/logging';
import { ProblemModule } from './shared/common/problem';
import { ConfigModule } from './shared/config';
import { DbModule } from './shared/db';

@Module({
  imports: [ConfigModule.forRoot(), LoggingModule, ProblemModule, HealthModule, DbModule],
})
export class AppModule {}
