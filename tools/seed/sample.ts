const DOMAINS = ['software', 'stem', 'non_technical'] as const;

/** First `n` entries taken round-robin across domains, so a small sample covers all three. */
export function spread<T extends { domain: string }>(rows: T[], n: number): T[] {
  const byDomain = DOMAINS.map((d) => rows.filter((row) => row.domain === d));
  const out: T[] = [];
  for (let i = 0; out.length < n && byDomain.some((list) => i < list.length); i++) {
    for (const list of byDomain) {
      const row = list[i];
      if (row && out.length < n) out.push(row);
    }
  }
  return out;
}
