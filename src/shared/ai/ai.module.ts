import Anthropic from '@anthropic-ai/sdk';
import { Global, Module } from '@nestjs/common';
import { AppConfig } from '../config';
import { AiBudgetGuard, SPEND_READER, type SpendReader } from './budget/budget.guard';
import { DrizzleSpendReader } from './budget/drizzle-spend.reader';
import { ClaudeStructuredGenerator } from './claude/claude.generator';
import { createGeminiClient, EMBEDDING_MODEL, GeminiEmbedder, GeminiStructuredGenerator } from './gemini/gemini.adapters';
import { DrizzleLlmCallRecorder, LLM_CALL_RECORDER, type LlmCallRecorder } from './metering/llm-call.recorder';
import { MeteredEmbedder, MeteredStructuredGenerator } from './metering/metered';
import { EMBEDDER, STRUCTURED_GENERATOR } from './ports';
import { PromptRegistry } from './prompts/prompt-registry';

const GEMINI_CLIENT = Symbol('GeminiClient');

/**
 * AI shared kernel (PRD-API §11): modules depend on the ports, never on a vendor SDK. Every call is
 * metered into llm_calls; cold-topic work checks AiBudgetGuard first.
 */
@Global()
@Module({
  providers: [
    { provide: LLM_CALL_RECORDER, useClass: DrizzleLlmCallRecorder },
    { provide: SPEND_READER, useClass: DrizzleSpendReader },
    {
      provide: GEMINI_CLIENT,
      inject: [AppConfig],
      useFactory: ({ env }: AppConfig) => createGeminiClient(env.GEMINI_API_KEY),
    },
    {
      provide: STRUCTURED_GENERATOR,
      inject: [AppConfig, GEMINI_CLIENT, LLM_CALL_RECORDER],
      useFactory: ({ env }: AppConfig, gemini: ReturnType<typeof createGeminiClient>, recorder: LlmCallRecorder) =>
        new MeteredStructuredGenerator(
          {
            anthropic: new ClaudeStructuredGenerator(new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })),
            google: new GeminiStructuredGenerator(gemini),
          },
          recorder,
        ),
    },
    {
      provide: EMBEDDER,
      inject: [GEMINI_CLIENT, LLM_CALL_RECORDER],
      useFactory: (gemini: ReturnType<typeof createGeminiClient>, recorder: LlmCallRecorder) =>
        new MeteredEmbedder(new GeminiEmbedder(gemini), EMBEDDING_MODEL, recorder),
    },
    {
      provide: AiBudgetGuard,
      inject: [SPEND_READER, AppConfig],
      useFactory: (spend: SpendReader, { env }: AppConfig) => new AiBudgetGuard(spend, env.AI_DAILY_BUDGET_USD),
    },
    { provide: PromptRegistry, useFactory: () => new PromptRegistry() },
  ],
  exports: [STRUCTURED_GENERATOR, EMBEDDER, AiBudgetGuard, PromptRegistry],
})
export class AiModule {}
