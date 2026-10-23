import { type ValidationFlag, type ValidationInput, validatePath } from '../domain';
import { type DesignedPath, type DesignRequest, type PathDesigner } from './ports/path-designer';

export interface DesignOutcome {
  designed: DesignedPath;
  /** Empty when the path passed; otherwise the second attempt's errors (the path goes to review). */
  errors: string[];
  flags: ValidationFlag[];
  attempts: number;
}

/**
 * Design, validate in code, and regenerate once with the validator's errors (plan §1.2.3). Shared by the
 * generate-path job and `pnpm eval:paths`, so the eval measures exactly what production runs.
 */
export async function designPath(
  designer: PathDesigner,
  request: DesignRequest,
  check: Omit<ValidationInput, 'steps'>,
  onStep?: (phase: 'design' | 'validate', attempt: number) => Promise<void>,
): Promise<DesignOutcome> {
  let errors: string[] = [];
  for (let attempt = 1; ; attempt += 1) {
    await onStep?.('design', attempt);
    const designed = await designer.design(attempt === 1 ? request : { ...request, feedback: errors });
    await onStep?.('validate', attempt);
    const result = validatePath({ ...check, steps: designed.steps });
    errors = result.errors;
    if (result.ok || attempt === 2) return { designed, errors, flags: result.flags, attempts: attempt };
  }
}
