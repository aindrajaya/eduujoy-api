# Held-out v2: provenance

`topic-resolve-holdout-v2.json` was written and committed (`1e4e49b`, 22 Oct 2026 14:25 local) before
any `seed:topics-refine` call: the sample ran at 14:30 local and the batch at 14:37 (`seed/_spend.md`,
07:30 and 07:37 UTC). It is blind to the refined topics' effect. No topic resolve has been run against
refined topics, and they have not been embedded.

What the author knew: the v1 failure list in `docs/prompts/02-seed-resolve-fix.md` (geometry vs
trigonometry, world-history, a Korean phrase getting Spanish as a choice). Three v2 cases touch those
topics: "the renaissance, the reformation and the age of exploration" (world-history), "finding a missing
side with the sine and cosine rules" (trigonometry) and the near-miss "portuguese verb conjugations". No
other v1 result or error was used.

Refine targets came only from embedding cosine (`--min-cosine 0.789` over the recorded topic vectors in
`test/fixtures/catalog/embeddings.json`: 61 pairs, 69 topics) plus that failure list (geometry,
trigonometry, world-history, spanish), and later the 10 new language topics via `--topics`.

Checked against the final 160-topic catalog (150 plus 10 languages): no case's expectation changes, no
phrase is an exact topic name or alias, and every slug exists. No v2 case was edited. Outside this file,
the A6 golden case "learning japanese" (expects new) and held-out v1 "korean for absolute beginners"
(expects new) now name catalog topics (`japanese`, `korean`).
