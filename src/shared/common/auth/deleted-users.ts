import { ACCESS_TOKEN_TTL_SECONDS } from './access-token.service';

/**
 * Deleted accounts whose access JWTs may still be unexpired (user decision, 22 Oct 2026). JwtAuthGuard
 * refuses them, so a deleted learner's token stops working at once instead of up to 15 minutes later.
 *
 * Accepted gap: the list lives in this process only. A restart or an overlapping deploy within the
 * access-token lifetime loses it, and that window falls back to the token's own expiry. Revisit (move
 * it to the database or Redis) if the API ever runs more than one instance.
 */
export class DeletedUsers {
  private readonly until = new Map<string, number>();

  constructor(
    private readonly ttlMs: number = ACCESS_TOKEN_TTL_SECONDS * 1000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  add(userId: string): void {
    this.prune();
    this.until.set(userId, this.now() + this.ttlMs);
  }

  has(userId: string): boolean {
    const expires = this.until.get(userId);
    if (expires === undefined) return false;
    if (expires <= this.now()) {
      this.until.delete(userId);
      return false;
    }
    return true;
  }

  get size(): number {
    this.prune();
    return this.until.size;
  }

  private prune(): void {
    const now = this.now();
    for (const [id, expires] of this.until) if (expires <= now) this.until.delete(id);
  }
}
