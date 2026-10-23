# Path-eval v1: provenance

`path-eval-v1.json` is the A9 path-eval golden set (docs/prompts/03-path-eval-set.md), in the case format
agreed with the API lane (docs/plans/A9-pathing.md, "Eval case format"; answers of 23 Oct 2026).

- **Written before any A9 generator output existed.** No path from the A9 generator (or any draft of
  `src/prompts/path-designer`) was seen, run or used while writing these cases. References describe what a
  good path for the learner must contain; they are not copies of a generated path.
- **Inputs** (`path-eval-plan.json`) come from code (`tools/seed/path-eval.ts`, `buildPlan`): topics from
  `scripts/discovery/pregen-topics.json` on `feat/pregen-script`, placements, weekly hours, formats and
  the 30-case smoke subset, chosen for spread, not from any generator result.
- **Goals and references** were drafted by Claude Sonnet 5.5 (prompt `path-eval-draft/v1`) and reviewed by
  Claude Sonnet 5.5 (prompt `path-eval-review/v1`: keep, revise or drop). Every draft and revision passed the
  rule check in code (step range, sop length, Bloom start/end and never going down, novice band, every
  `mustCover` concept in the sop, order constraints held, no URLs). `startBloomMax` and `endBloom` come from
  code: novice ends at C2 (provisional, pending the lead), advanced_beginner C4, competent C5, proficient
  and expert C6.
- **Retries:** pe-007's draft was rejected three times for a Bloom drop and passed when the request named
  the broken rule; 11 smoke reviews over the agreed limits passed on a re-review that named the limits.
- **Human check:** the user spot-checks samples; the master PRD's two in-house reviewers still score
  generated paths at Gate B.

Status: the 30 smoke cases (pe-001 to pe-030) are written; pe-031 to pe-090 follow after the user's go.
