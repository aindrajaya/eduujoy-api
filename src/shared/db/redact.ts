const CONNECTION_STRING = /\b(postgres(?:ql)?):\/\/[^\s'"]+/gi;

/** Connection strings carry passwords; strip them from anything that may be printed or logged. */
export function redactConnectionStrings(text: string): string {
  return text.replace(CONNECTION_STRING, '$1://[redacted]');
}

export function describeError(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return redactConnectionStrings(text);
}
