import { Module } from '@nestjs/common';
import { LoggingModule } from './shared/common/logging';
import { ConfigModule } from './shared/config';

@Module({
  imports: [ConfigModule.forRoot(), LoggingModule],
})
export class AppModule {}
