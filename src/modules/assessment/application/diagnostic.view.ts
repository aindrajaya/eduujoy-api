import { type Placement, type Progress } from '../domain/diagnostic';
import { type ServedItem } from './ports/diagnostic.repository';

/** Contract DiagnosticBatchResponse. */
export interface DiagnosticBatchView {
  diagnosticId: string;
  status: 'in_progress' | 'completed';
  progress: Progress;
  items?: { id: string; kind: string; bloom: string; prompt: string; options?: { id: string; label: string }[] }[];
  placement?: { id: string; position: { stage: string; bloom: string }; confidence: number; reason: string };
}

export function itemsView(served: ServedItem[]): NonNullable<DiagnosticBatchView['items']> {
  return served.map(({ item, bloom, prompt, options }) => ({ id: item.id, kind: item.kind, bloom, prompt, options }));
}

export function placementView(id: string, placement: Placement): NonNullable<DiagnosticBatchView['placement']> {
  return { id, position: placement.position, confidence: placement.confidence, reason: placement.reason };
}
