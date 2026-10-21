export interface SelfReport {
  years?: number;
  projectsShipped?: number;
}

/**
 * Start cell from the self-report (spec, 22 Oct 2026). It only seeds the adaptive walk; the placement
 * comes from graded items, or from this cell when the topic has no item bank.
 */
export function startCell(report: SelfReport | null | undefined): number {
  if (!report || (report.years === undefined && report.projectsShipped === undefined)) return 0;
  const years = report.years ?? 0;
  const projects = report.projectsShipped ?? 0;
  if (years >= 10 && projects >= 20) return 8; // expert C5
  if (years >= 6 || projects >= 10) return 6; // proficient C4
  if (years >= 3 || projects >= 3) return 4; // competent C3
  if (years >= 1 || projects >= 1) return 2; // advanced beginner C2
  return 1; // novice C2
}
