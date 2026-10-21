export { AiModule } from './ai.module';
export { AiBudgetGuard, type BudgetStatus, type WorkKind } from './budget/budget.guard';
export { costUsd, MODELS, type ModelId, type TokenUsage } from './catalog';
export { AiBudgetExceededError, AiCallError, type AiFailure } from './errors';
export { EMBEDDING_MODEL, EMBEDDING_VERSION } from './gemini/gemini.adapters';
export {
  EMBEDDER,
  type Embedder,
  type EmbeddingRequest,
  type EmbeddingResult,
  type PromptRef,
  STRUCTURED_GENERATOR,
  type StructuredGenerator,
  type StructuredRequest,
  type StructuredResult,
} from './ports';
export { UNTRUSTED_DATA_RULE, wrapUntrusted } from './untrusted';
export { PromptNotFoundError, PromptRegistry } from './prompts/prompt-registry';
