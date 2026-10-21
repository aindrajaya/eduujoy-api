/** A learner's plan or credits changed (PRD-API §5); realtime pushes `entitlement.changed` (A11). */
export class EntitlementChanged {
  readonly type = 'EntitlementChanged';
  readonly occurredAt = new Date();

  constructor(
    readonly userId: string,
    readonly reason: 'purchase' | 'refund' | 'subscription',
  ) {}
}
