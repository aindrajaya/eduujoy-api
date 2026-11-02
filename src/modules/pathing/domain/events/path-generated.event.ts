/** A path's steps were saved and it is active (PRD-API §5); progress starts step 1, A11 pushes path.ready. */
export class PathGenerated {
  readonly type = 'PathGenerated';
  readonly occurredAt = new Date();

  constructor(
    readonly pathId: string,
    readonly userId: string,
    readonly topicId: string,
  ) {}
}
