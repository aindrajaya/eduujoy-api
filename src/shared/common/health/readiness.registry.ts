export type ReadinessCheck = () => Promise<unknown>;
export type CheckStatus = 'ok' | 'fail' | 'timeout';
export interface ReadinessResult {
  ready: boolean;
  checks: Record<string, CheckStatus>;
}

const TIMED_OUT = Symbol('timeout');

/** Modules register dependency checks here (for example the database in A1); `/ready` runs them. */
export class ReadinessRegistry {
  private readonly checks = new Map<string, ReadinessCheck>();

  constructor(private readonly timeoutMs = 2000) {}

  register(name: string, check: ReadinessCheck): void {
    if (this.checks.has(name)) throw new Error(`Readiness check already registered: ${name}`);
    this.checks.set(name, check);
  }

  async run(): Promise<ReadinessResult> {
    const entries = await Promise.all(
      [...this.checks].map(async ([name, check]) => [name, await this.runOne(check)] as const),
    );
    const checks = Object.fromEntries(entries);
    return { ready: entries.every(([, status]) => status === 'ok'), checks };
  }

  private async runOne(check: ReadinessCheck): Promise<CheckStatus> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => {
        resolve(TIMED_OUT);
      }, this.timeoutMs);
    });
    try {
      const outcome = await Promise.race([check(), timeout]);
      return outcome === TIMED_OUT ? 'timeout' : 'ok';
    } catch {
      return 'fail';
    } finally {
      clearTimeout(timer);
    }
  }
}
