export const PAPER_SEARCH = Symbol('PaperSearch');

export interface Paper {
  title: string;
  /** Where a learner reads it: the open-access landing page when there is one, else the DOI link. */
  url: string;
  doi: string | null;
  arxivId: string | null;
  /** `YYYY-MM-DD`. */
  publishedAt: string | null;
  /** Venue or index, shown as the source. */
  source: string;
  abstract: string | null;
}

/** OpenAlex with an arXiv fallback (`PaperSearch` in PRD-API §11). */
export interface PaperSearch {
  search(input: { query: string; limit: number; signal?: AbortSignal }): Promise<Paper[]>;
}
