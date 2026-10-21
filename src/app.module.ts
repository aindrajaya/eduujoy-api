import { Module } from '@nestjs/common';
import { HealthModule } from './shared/common/health';
import { LoggingModule } from './shared/common/logging';
import { ConfigModule } from './shared/config';
import { DbModule } from './shared/db';

@Module({
  imports: [ConfigModule.forRoot(), LoggingModule, HealthModule, DbModule],
})
export class AppModule {}
