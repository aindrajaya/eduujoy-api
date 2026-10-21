import { Module } from '@nestjs/common';
import { IdentityModule } from './modules/identity/identity.module';
import { AiModule } from './shared/ai';
import { AuthKernelModule } from './shared/common/auth';
import { HealthModule } from './shared/common/health';
import { LoggingModule } from './shared/common/logging';
import { ProblemModule } from './shared/common/problem';
import { SerializationModule } from './shared/common/serialization';
import { ConfigModule } from './shared/config';
import { DbModule } from './shared/db';
import { EventsModule } from './shared/events';
import { JobsModule } from './shared/jobs';

@Module({
  imports: [
    ConfigModule.forRoot(),
    LoggingModule,
    ProblemModule,
    SerializationModule,
    AuthKernelModule,
    HealthModule,
    DbModule,
    EventsModule,
    JobsModule,
    AiModule,
    IdentityModule,
  ],
})
export class AppModule {}
