# Eduujoy API

[![CI](https://github.com/aindrajaya/eduujoy-api/actions/workflows/ci.yml/badge.svg)](https://github.com/aindrajaya/eduujoy-api/actions/workflows/ci.yml)
[![CodeQL](https://github.com/aindrajaya/eduujoy-api/actions/workflows/codeql.yml/badge.svg)](https://github.com/aindrajaya/eduujoy-api/actions/workflows/codeql.yml)

Backend for [Eduujoy](https://eduujoy.aindrajaya.my.id), a product that builds a personalised
learning path for any topic. A learner names a topic, takes a short diagnostic, is placed on a skill
stage, and receives a path of vetted resources to work through step by step.

This service owns every rule, every AI call and all data. The React front end
([aindrajaya/eduujoy-ui](https://github.com/aindrajaya/eduujoy-ui)) only renders and calls this API.

- Production: `https://api.eduujoy.aindrajaya.my.id` (`/health`, `/ready`)
- API contract: [`openapi.json`](openapi.json), checked in CI against the frozen
  [`docs/contract/openapi.v0.yaml`](docs/contract/openapi.v0.yaml)
- Design document: [`docs/PRD-API.md`](docs/PRD-API.md)

## Stack

| Concern | Choice |
| --- | --- |
| Runtime | Node.js 24 in CI and Docker (22+ supported), TypeScript `strict`, pnpm |
| Framework | NestJS 11, modular monolith |
| Database | PostgreSQL with `pgvector` (768-dimension embeddings, HNSW indexes) |
| ORM and migrations | Drizzle ORM, plain-SQL migrations in [`drizzle/`](drizzle) |
| Background jobs | A Postgres `jobs` table and an in-process executor behind a queue port |
| Validation | `class-validator` DTOs at the edge, Zod for environment and AI output |
| Auth | Email and password (Argon2) and Google OAuth with PKCE; cookie sessions with refresh rotation |
| AI | Anthropic and Gemini SDKs behind ports, with metering and a daily budget guard |
| Payments | Lemon Squeezy checkout and HMAC-verified webhooks |
| Tests | Jest unit, integration and Supertest e2e suites against a real Postgres |
| Deploy | Multi-stage Dockerfile, non-root runtime user, Koyeb |

## Architecture

Each bounded context is a Nest module that reaches the others only through an application service
or a domain event. No module imports another module's repository or tables; an ESLint boundaries
rule ([`eslint.boundaries.mjs`](eslint.boundaries.mjs)) fails CI on a violation.

| Module | Owns |
| --- | --- |
| `identity` | Users, sessions, roles, OAuth |
| `account` | Personal data export and account deletion |
| `catalog` | Topics, aliases, topic embeddings, free-text resolution |
| `assessment` | Diagnostic items, attempts, placement |
| `discovery` | Resource search, analysis and liveness |
| `pathing` | Paths, steps and path generation |
| `progress` | Learner positions and history |
| `billing` | Checkout, webhooks, entitlements, credit ledger |

Inside a module, dependencies point inward only: `interface/` (controllers, DTOs) →
`application/` (use cases, ports) → `domain/` (pure TypeScript), with `infrastructure/`
(Drizzle repositories, adapters, job handlers) implementing the ports.

The shared kernel in [`src/shared`](src/shared) holds what every module needs: `ai`, `jobs`,
`events`, `db`, `config` and `common` (guards, filters, problem+json errors).

### Design decisions worth reading

- **Jobs without a broker.** Long work (resource discovery, path generation) is a row in Postgres,
  claimed with `FOR UPDATE SKIP LOCKED` and resumed on boot. Progress streams to the client over
  SSE at `GET /v1/jobs/{id}/events`. One process, one stateful dependency.
- **Events after commit.** Domain events are published through a unit of work, only after the
  transaction that produced them has committed.
- **AI behind ports.** Modules never call a vendor SDK. Every call goes through a port in
  [`src/shared/ai`](src/shared/ai), where retries, cost metering and the daily budget guard live.
  Model output is parsed with Zod before use, and prompts are versioned files in
  [`src/prompts`](src/prompts).
- **Untrusted content stays data.** Web pages, transcripts and learner answers are wrapped in a
  delimited block before they reach a model, so they cannot pose as instructions
  ([`src/shared/ai/untrusted.ts`](src/shared/ai/untrusted.ts)).
- **Guards against the wrong database.** The migration CLI and the test harness refuse to run
  against the production endpoint ([`src/shared/db/cli/target-guard.ts`](src/shared/db/cli/target-guard.ts)).

## API surface

| Area | Endpoints |
| --- | --- |
| Health | `GET /health`, `GET /ready` |
| Auth | `POST /v1/auth/register`, `login`, `refresh`, `logout`; `GET /v1/auth/me`; Google OAuth start and callback |
| Topics | `POST /v1/topics/resolve` |
| Diagnostics | `POST /v1/diagnostics`, `GET /v1/diagnostics/{id}`, `POST /v1/diagnostics/{id}/answers` |
| Paths and steps | `GET` and `POST /v1/paths`, `GET /v1/paths/{id}`, `PATCH /v1/steps/{id}` |
| Jobs | `GET /v1/jobs/{id}/events` (SSE) |
| Billing | `POST /v1/billing/checkout`, `POST /v1/billing/webhook` |
| Account | `GET /v1/me/export`, `DELETE /v1/me` |

Request and response shapes are in [`openapi.json`](openapi.json). Regenerate it with
`pnpm openapi:export` after changing a DTO or a route.

## Getting started

Requires Node 22+, pnpm (version pinned in `package.json`) and a PostgreSQL database with the
`pgvector` extension.

```bash
pnpm install
cp .env.example .env        # then fill in the values
pnpm db:migrate             # uses DATABASE_URL_DIRECT
pnpm start:dev              # http://localhost:3000
```

Configuration is validated at boot by [`src/shared/config/env.ts`](src/shared/config/env.ts); the
process exits with a list of what is missing or malformed. The full set of required variables,
with placeholder values, is in [`.github/ci/smoke-env.list`](.github/ci/smoke-env.list).

## Scripts

| Script | What it does |
| --- | --- |
| `pnpm start:dev` | Nest in watch mode |
| `pnpm build` | Compile to `dist/` |
| `pnpm lint` | ESLint, including the module boundary rules |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | Unit tests (no database needed) |
| `pnpm test:int` | Integration tests against `DATABASE_URL_TEST` |
| `pnpm test:e2e` | Supertest end-to-end tests against `DATABASE_URL_TEST` |
| `pnpm db:generate` | Generate a migration from the Drizzle schema |
| `pnpm db:migrate` | Apply migrations |
| `pnpm openapi:export` | Regenerate `openapi.json` |
| `pnpm openapi:check` | Diff the generated contract against the frozen one |

## Testing

- **Unit** tests sit next to the code as `*.spec.ts` and need nothing but Node.
- **Integration and e2e** tests run against a real Postgres. Each run works in its own schema, and
  a scheduled workflow sweeps leftovers. `DATABASE_URL_TEST` must be a direct (not pooled)
  connection, and the harness refuses a URL that points at the production or development database.
- Model responses used by the suites are recorded fixtures under [`test/`](test).
- In CI those two suites use a dedicated Neon branch supplied as a repository secret, so they do
  not run on pull requests from forks.

## CI

Every push to `main` and every pull request runs:

1. **CI / verify**: lint, typecheck, unit tests with coverage, integration tests, e2e tests,
   build, OpenAPI contract check and `pnpm audit` on production dependencies.
2. **CI / docker**: builds the image and boots it against a freshly migrated Postgres, then calls
   `/health` and `/ready`.
3. **CodeQL**: fails on any finding of medium severity or higher.
4. **polinrider-guard**: scans git objects for known malware indicators without running repo code.

`main` accepts signed commits only, and `verify`, CodeQL and the guard must pass before a merge.

## Security

See [`SECURITY.md`](SECURITY.md) for how to report a vulnerability and for the October 2026
supply-chain incident note.

## License

All rights reserved. The source is published for viewing and evaluation only; see
[`LICENSE`](LICENSE).
