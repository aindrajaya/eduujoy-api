# AI fixtures

HTTP exchanges replayed by the offline contract tests (`test/ai/*.spec.ts`), so CI runs without API keys.

- Re-record with `pnpm ai:record-fixtures`. It makes a few tiny real calls (well under US$0.01) and never writes headers or keys.
- Files with `"synthetic": true` were written by hand from the provider's documented REST shapes, because the recording could not run (Gemini prepaid credits were depleted on 21 Oct 2026). Re-record them once the project has credit.
