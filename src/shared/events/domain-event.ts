/**
 * A domain event (PRD-API §5). Modules declare their events as plain classes in their domain layer;
 * `type` is the bus channel, for example `PlacementComputed`.
 */
export interface DomainEvent {
  readonly type: string;
  readonly occurredAt: Date;
}
