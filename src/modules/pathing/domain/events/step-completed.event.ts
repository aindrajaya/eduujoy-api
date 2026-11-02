/** The learner completed or skipped a step (PRD-API §5); A11 records progress and streaks. */
export class StepCompleted {
  readonly type = 'StepCompleted';
  readonly occurredAt = new Date();

  constructor(
    readonly pathId: string,
    readonly stepId: string,
    readonly userId: string,
    readonly outcome: 'completed' | 'skipped',
    readonly pathCompleted: boolean,
  ) {}
}
