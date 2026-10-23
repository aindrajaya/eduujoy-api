import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { PromptRegistry, STRUCTURED_GENERATOR, type StructuredGenerator, wrapUntrusted } from '../../../shared/ai';
import { type DesignedPath, type DesignRequest, type PathDesigner } from '../application/ports/path-designer';
import { BANDS, BLOOMS, MAX_STEPS } from '../domain';

export const PATH_DESIGNER_PROMPT = 'path-designer';
const MODEL = 'claude-sonnet-5-5';

const nullableSec = z.number().int().min(0).max(24 * 3600).nullable();

/** The designer's answer; every AI output is parsed with Zod. The validator checks the path rules. */
export const designSchema = z.object({
  steps: z
    .array(
      z.object({
        n: z.number().int().min(1).max(50),
        objective: z.string().max(400),
        bloom: z.enum(BLOOMS as unknown as [string, ...string[]]),
        resources: z.array(z.string().regex(/^r\d{1,3}$/)).max(5),
        actions: z
          .array(z.object({ text: z.string().min(1).max(400), resource: z.string().regex(/^r\d{1,3}$/).nullable(), startSec: nullableSec, endSec: nullableSec }))
          .max(8),
        checkpoint: z.object({
          items: z
            .array(
              z.object({
                kind: z.enum(['single_choice', 'multi_choice', 'short_answer', 'open']),
                prompt: z.string().min(1).max(600),
                options: z.array(z.object({ id: z.string().regex(/^[a-h]$/), label: z.string().min(1).max(300) })).max(8),
                correctOptionIds: z.array(z.string().regex(/^[a-h]$/)).max(8),
                expectedAnswer: z.string().max(600).nullable(),
              }),
            )
            .max(5),
          rubric: z.array(z.string().min(1).max(200)).max(6),
          passScore: z.number().int().min(0).max(100),
        }),
        doneWhen: z.string().max(400),
        estMinutes: z.number().int().min(0).max(24 * 60),
      }),
    )
    .min(1)
    .max(MAX_STEPS + 4),
});

/**
 * Claude path design (PRD-API §11). The system prompt (rules, stage table, schema, example) is stable
 * and cached; the learner's placement, goal and the pool go in the user turn, with every text that
 * came from the web or the learner wrapped as untrusted data.
 */
@Injectable()
export class ClaudePathDesigner implements PathDesigner {
  readonly promptVersion: string;

  constructor(
    @Inject(STRUCTURED_GENERATOR) private readonly generator: StructuredGenerator,
    private readonly prompts: PromptRegistry,
  ) {
    this.promptVersion = prompts.get(PATH_DESIGNER_PROMPT).version;
  }

  async design(request: DesignRequest): Promise<DesignedPath> {
    const { output, call } = await this.generator.generate({
      stage: 'design',
      model: MODEL,
      prompt: this.prompts.get(PATH_DESIGNER_PROMPT, this.promptVersion),
      input: renderRequest(request),
      schema: designSchema,
      maxTokens: 16_000,
      effort: 'medium',
      ...(request.jobId ? { jobId: request.jobId } : {}),
      ...(request.budgetScope ? { budgetScope: request.budgetScope } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
    });
    return { steps: output.steps as DesignedPath['steps'], model: call.model, promptVersion: this.promptVersion };
  }
}

/** The user turn: facts as plain lines, every web- or learner-written text inside <data>. */
export function renderRequest(r: DesignRequest): string {
  const band = BANDS[r.target];
  const cards = r.cards.map((c) =>
    [
      `${c.alias}: ${c.type}, stage ${c.stage}, Bloom ${c.bloomLevels.join('/')}, ${c.durationMin !== null ? `video ${c.durationMin} min` : c.readingMin !== null ? `reading ${c.readingMin} min` : 'length unknown'}`,
      wrapUntrusted(`${c.alias}-title`, `${c.title} (${c.source})`),
      c.prerequisites.length ? wrapUntrusted(`${c.alias}-prerequisites`, c.prerequisites.join('; ')) : `${c.alias} prerequisites: none`,
      c.concepts.length
        ? wrapUntrusted(`${c.alias}-chapters`, c.concepts.map((k) => (k.start && k.end ? `${k.name} [${k.start}–${k.end}]` : k.name)).join('; '))
        : `${c.alias} chapters: none listed`,
      c.keyTakeaways.length ? wrapUntrusted(`${c.alias}-takeaways`, c.keyTakeaways.join(' ')) : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
  return [
    `Topic: ${r.topic.name} (${r.topic.domain})`,
    `Learner: ${r.placement.stage}, Bloom ${r.placement.bloom}`,
    `Path climbs the ${r.target} band (${band.bottom}–${band.top}); the last step must be ${band.top}.`,
    r.goal ? wrapUntrusted('learner-goal', r.goal) : 'Goal: none given',
    `Weekly hours: ${r.weeklyHours}; time budget for the whole path: ${r.budgetMinutes} minutes.`,
    `Preferred formats: ${r.formats.length ? r.formats.join(', ') : 'any'}`,
    '',
    `Resources (${r.cards.length}):`,
    ...cards,
    ...(r.feedback?.length ? ['', 'Your previous answer failed these checks; fix every one:', ...r.feedback.map((e) => `- ${e}`)] : []),
  ].join('\n');
}
