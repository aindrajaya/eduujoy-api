import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '../config';
import { type Env } from '../config/env';
import { DATABASE } from '../db';
import { AiModule } from './ai.module';
import { AiBudgetGuard } from './budget/budget.guard';
import { MeteredEmbedder, MeteredStructuredGenerator } from './metering/metered';
import { EMBEDDER, STRUCTURED_GENERATOR } from './ports';
import { PromptRegistry } from './prompts/prompt-registry';

@Global()
@Module({ providers: [{ provide: DATABASE, useValue: {} }], exports: [DATABASE] })
class FakeDbModule {}

describe('AiModule', () => {
  it('wires metered ports, the budget guard and the prompt registry without touching the network', async () => {
    const env = { ANTHROPIC_API_KEY: 'a', GEMINI_API_KEY: 'g', AI_DAILY_BUDGET_USD: 5 } as Env;
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot(env), FakeDbModule, AiModule],
    }).compile();

    expect(moduleRef.get(STRUCTURED_GENERATOR)).toBeInstanceOf(MeteredStructuredGenerator);
    expect(moduleRef.get(EMBEDDER)).toBeInstanceOf(MeteredEmbedder);
    expect(moduleRef.get(AiBudgetGuard)).toBeInstanceOf(AiBudgetGuard);
    expect(moduleRef.get(PromptRegistry)).toBeInstanceOf(PromptRegistry);
    await moduleRef.close();
  });
});
