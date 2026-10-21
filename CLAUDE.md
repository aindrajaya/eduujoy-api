# Eduujoy API (NestJS)
Specs: ../docs/PRD-MASTER.md (product, wins on scope) and docs/PRD-API.md (implementation).
- One slice at a time: finish, verify, commit, update status, then start the next. Slices come from PRD-API Section 13 in the order in ../docs/EXECUTION-PLAN.md; branch slice/A<n>-<name>; commit prefix `api:`. Status lives in ../docs/status/api.md.
- Frozen contract: ../docs/contract/openapi.v0.yaml. Stay compatible with it; propose changes under "Contract change requests" in ../docs/status/api.md instead of breaking it.
- tools/seed and seed/ belong to the credit-sprint session; do not modify them.
- Run git, pnpm and tests from inside api/ (separate repo).
- Respect module boundaries (PRD-API Section 4); never import another module's infrastructure.
- Every input is a DTO with class-validator bounds; every AI output is parsed with Zod.
- After changing a DTO or route, run `pnpm openapi:export` so api/openapi.json stays current.
- Run the slice's Verify commands; do not mark done until they pass.
- If the PRD is ambiguous, stop and list the question instead of guessing.
- Env: APP_ORIGIN=https://eduujoy.aindrajaya.my.id; cookies are host-only on api.eduujoy.aindrajaya.my.id with SameSite=Lax.
