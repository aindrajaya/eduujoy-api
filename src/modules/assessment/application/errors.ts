export class TopicNotFoundError extends Error {
  override name = 'TopicNotFoundError';
}

export class DiagnosticNotFoundError extends Error {
  override name = 'DiagnosticNotFoundError';
}

/** The session belongs to someone else (answers: 403; reads answer 404 so ids aren't probeable). */
export class NotDiagnosticOwnerError extends Error {
  override name = 'NotDiagnosticOwnerError';
}

/** The diagnostic is already complete, or the answers don't match the outstanding batch. */
export class DiagnosticConflictError extends Error {
  override name = 'DiagnosticConflictError';
}
