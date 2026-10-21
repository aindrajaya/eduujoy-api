# Seed format v1

`pnpm db:seed [--dir seed] [--expect-topics N]` loads this format into the database. The parser (`src/shared/db/seed/seed-data.ts`) validates it strictly: unknown fields, broken references and cycles fail the whole load and list every problem. The credit-sprint tooling (`tools/seed`) should write exactly this. To change the format, update the parser and this file together.

```text
seed/
  topics.json            # required
  items/<topic-slug>.json  # optional, one file per topic
```

## topics.json

```json
{
  "version": 1,
  "topics": [
    {
      "slug": "react-hooks",
      "canonicalName": "React hooks",
      "aliases": ["hooks", "useState"],
      "description": "Managing state and side effects in React function components.",
      "domain": "software",
      "parent": "javascript",
      "prerequisites": ["javascript"]
    }
  ]
}
```

| Field | Rule |
| --- | --- |
| `slug` | kebab-case, ≤ 80 chars, unique; it's the upsert key |
| `canonicalName` | 1–120 chars |
| `aliases` | ≤ 30 strings |
| `description` | 1–500 chars; it's embedded together with the name and aliases (PRD-API §8) |
| `domain` | `software`, `stem` or `non_technical` |
| `parent` | another slug in the file, or `null` |
| `prerequisites` | ≤ 20 slugs in the file; no cycles and no self-edges |

## items/&lt;topic-slug&gt;.json

```json
{
  "version": 1,
  "topic": "javascript",
  "items": [
    {
      "key": "nov-c1-typeof",
      "stage": "novice",
      "bloom": "C1",
      "kind": "single_choice",
      "prompt": "What does `typeof null` return?",
      "options": [{ "id": "a", "label": "\"null\"" }, { "id": "b", "label": "\"object\"" }],
      "answerKey": { "optionIds": ["b"] },
      "rubric": ["..."],
      "reviewed": false
    }
  ]
}
```

| Field | Rule |
| --- | --- |
| `topic` | must match the file name and a slug in `topics.json` |
| `key` | `[a-z0-9_-]{1,40}`, unique within the file; the stored `seed_key` is `<topic>:<key>` |
| `stage` | `novice`, `advanced_beginner`, `competent`, `proficient` or `expert` |
| `bloom` | `C1`–`C6` |
| `kind` | `single_choice`, `multi_choice`, `short_answer` or `scenario` |
| `options` | 2–8 options, required for choice kinds and not allowed otherwise |
| `answerKey` | `optionIds` must reference options (exactly one for `single_choice`); `text` is a model answer for open kinds. Answer keys are never returned by the API |
| `rubric` | optional, ≤ 10 criteria |
| `reviewed` | defaults to `false` |

## Loading behaviour

- Each run is one transaction. Topics upsert by `slug` and items by `seed_key`, so re-running converges on the files.
- Prerequisite edges of seeded topics are replaced on every run. Topics that aren't in the files are left alone, for example ones created by learners.
- Embeddings are not loaded. The catalog slice (A6) backfills them.
- Concept maps and golden sets are not loaded yet: they have no table in the data model. Add them to this format when a slice needs them.
