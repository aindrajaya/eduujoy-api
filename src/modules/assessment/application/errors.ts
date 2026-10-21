export class TopicNotFoundError extends Error {
  override name = 'TopicNotFoundError';
}

export class DiagnosticNotFoundError extends Error {
  override name = 'DiagnosticNotFoundError';
}

/** The diagnostic is already complete, or the answers don't match the outstanding batch. */
export class DiagnosticConflictError extends Error {
  override name = 'DiagnosticConflictError';
}
