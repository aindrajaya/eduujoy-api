import { Module } from '@nestjs/common';
import { HealthModule } from './shared/common/health';
import { LoggingModule } from './shared/common/logging';
import { ConfigModule } from './shared/config';

@Module({
  imports: [ConfigModule.forRoot(), LoggingModule, HealthModule],
})
export class AppModule {}
