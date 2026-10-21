# AI fixtures

HTTP exchanges replayed by the offline contract tests (`test/ai/*.spec.ts`), so CI runs without API keys.

- All four files are real recordings (21 Oct 2026): Claude Haiku 5.5 and Sonnet 5.5 structured output, Gemini 3.5 Flash-Lite structured output, and two `gemini-embedding-2` document embeddings (768 dims, normalised).
- Re-record with `pnpm ai:record-fixtures` (the user runs it; it uses `node --env-file=.env`). It makes a few tiny real calls (well under US$0.01), reads keys from `process.env` only, and never writes headers or keys.
- Tests that need cases the recordings don't contain (refusals, cache reads, thinking tokens, errors) edit a copy of a recording in memory rather than adding hand-built files.
