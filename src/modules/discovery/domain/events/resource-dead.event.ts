/** A served link failed its liveness checks (FR-12); pathing swaps it for the next best (PRD-API §5). */
export class ResourceDead {
  readonly type = 'ResourceDead';
  readonly occurredAt = new Date();

  constructor(
    readonly resourceId: string,
    readonly url: string,
  ) {}
}
