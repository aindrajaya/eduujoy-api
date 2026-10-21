import { Module } from '@nestjs/common';
import { ConfigModule } from './shared/config';

@Module({
  imports: [ConfigModule.forRoot()],
})
export class AppModule {}
