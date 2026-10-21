# Eduujoy — API PRD (NestJS)

Oct 21, 2026 · @Arista Indra

## 1. Scope

The API service is a single NestJS application in its own repository, deployed to Koyeb. It owns every rule, every AI call and all data. The React front end only renders and calls this API.

**Document hierarchy**

1. [Master PRD](https://claude.ai/artifact/BGaNeyavYS9oNGGk4zEGWY): product, learning framework, functional requirements (FR-xx), metrics. It wins on any conflict.
2. **API PRD (this doc):** how the backend implements the master PRD.
3. **UI PRD:** how the front end implements it ([UI PRD](https://claude.ai/artifact/B4vbnZepzeEBCzfXU9aVh9)).

**How Claude Code uses this doc**

- Workspace layout: `eduujoy/docs/PRD-MASTER.md` at the root, this file at `eduujoy/api/docs/PRD-API.md`, and `eduujoy/api/CLAUDE.md` beside the code. `api/` is its own git repository.
- Claude Code is launched from `eduujoy/`; the root `CLAUDE.md` loads at launch and `api/CLAUDE.md` loads when Claude first reads a file in `api/`.
- Each session implements one slice from Section 13, runs its verification commands, and stops. Every pull request names the slice ID and the FR IDs it covers.

**In scope:** auth, RBAC, topics, diagnostics, resource discovery and analysis, SOP generation, checkpoints and grading, progress, real-time events, billing webhooks, admin endpoints.

**Out of scope:** UI rendering, video hosting or playback logic, email marketing, mobile apps.

## 2. Architecture at a glance

&#91;embedded content: API architecture · 9 modules, shared kernel, 6 external services\]

Modules never call vendors directly: every outside call goes through a port in the shared kernel, which is where metering, retries and fixtures live.

## 3. Stack and infrastructure

The MVP runs as one NestJS process on Koyeb's free instance, with jobs in the same process and Postgres as the only stateful dependency. No Redis until a second instance is needed.

| Concern | Choice | Why |
| --- | --- | --- |
| Runtime | Node.js LTS, TypeScript `strict`, pnpm | Matches the existing stack |
| Framework | NestJS, modular monolith | DI, guards, pipes, interceptors, gateways out of the box |
| Database | Neon Postgres (free) + `pgvector` | Serverless Postgres; vectors live next to relational data |
| ORM and migrations | Drizzle ORM + drizzle-kit | First-class `vector` column type, typed SQL, plain-SQL migrations |
| Jobs | Postgres `jobs` table + in-process executor behind a `JobQueue` port | Durable, no extra service; swap to BullMQ or pg-boss when scaling out |
| Domain events | `@nestjs/event-emitter`, published after commit | In-process, typed, testable |
| Real-time | SSE (native Nest `@Sse`) + Socket.IO gateway (`@nestjs/websockets`) | SSE for job streams; WebSocket for user notifications |
| Validation | `class-validator` DTOs at the edge; Zod for AI outputs and env | Strict input and strict model output |
| Docs and types | `@nestjs/swagger` → `openapi.json` → `openapi-typescript` in the UI repo | One contract for two repos |
| Logging and errors | `nestjs-pino` (JSON logs, request IDs), Sentry | Searchable logs, alerting |
| Tests | Jest unit tests, Supertest e2e, a Neon test branch (one schema per run, no Docker) | Real database in CI |
| Deploy | Dockerfile → Koyeb (Frankfurt or Washington, D.C.), GitHub Actions CI | Push-to-deploy |

**Free-tier constraints and how the design absorbs them**

| Limit | Value | Design response |
| --- | --- | --- |
| Koyeb free instance | One web service; 512 MB RAM, 0.1 vCPU ([Koyeb pricing FAQ](https://www.koyeb.com/docs/faq/pricing)) | Single process; video analysis is network-bound, so concurrency 2 per job type; heap capped at 384 MB |
| Koyeb scale-to-zero | Sleeps after 1 h without traffic; 1–5 s cold start; cannot be disabled on free ([scale to zero](https://www.koyeb.com/docs/run-and-scale/scale-to-zero)) | On boot, resume `queued` and `running` jobs; the UI shows a "waking up" state on first request |
| Neon free compute | 100 CU-hours per project per month; suspends after 5 min idle ([Neon free plan](https://neon.com/faqs/free-plan-limits-and-quotas)) | No polling loops; jobs are pushed, not polled; pooled connection string for the app, direct one for migrations |
| Neon free storage | 1 GB per project | 768-dimension vectors (\~3 KB each); transcripts never stored; prune `llm_calls` older than 90 days |

**Upgrade triggers:** move Koyeb to a paid Eco or nano instance when p95 latency exceeds targets or cold starts hurt activation. Add Upstash Redis and a separate worker service when one instance cannot keep up with jobs.

### Domains and DNS

Both hosts sit under `aindrajaya.my.id`, whose DNS is managed in Vercel; the API subdomain reaches Koyeb through one CNAME record, so cookies stay same-site.

| Host | Serves | Hosted on | DNS record (Vercel DNS for `aindrajaya.my.id`) | TLS |
| --- | --- | --- | --- | --- |
| `eduujoy.aindrajaya.my.id` | React SPA (production) | Vercel UI project | Assigned to the UI project in Vercel | Vercel |
| `staging.eduujoy.aindrajaya.my.id` | React SPA (`develop` branch) | Vercel UI project, branch domain | Assigned to the `develop` branch in Vercel | Vercel |
| `api.eduujoy.aindrajaya.my.id` | NestJS API | Koyeb app | `CNAME api.eduujoy → <org-uuid>.cname.koyeb.app` (exact value from Koyeb) | Koyeb, automatic |

**One-time setup (part of slice A0)**

1. Koyeb → **Domains** → add `api.eduujoy.aindrajaya.my.id`, select the API app, copy the CNAME target.
2. Vercel → **Domains** → `aindrajaya.my.id` → **DNS Records** → add Name `api.eduujoy`, Type `CNAME`, Value = the Koyeb target. CLI: `vercel dns add aindrajaya.my.id api.eduujoy CNAME <org-uuid>.cname.koyeb.app`.
3. Verify with `dig api.eduujoy.aindrajaya.my.id CNAME +noall +answer`, then click **Refresh** in Koyeb until the domain is **Active** (usually under 5 min, up to 4 h).
4. Set the environment variables below, then register the OAuth callback in Google Cloud and the webhook URL in Lemon Squeezy.
5. Smoke test: `curl -I https://api.eduujoy.aindrajaya.my.id/health` returns `200` with a valid certificate; signing in from the UI sets `ej_at` on the API host with `Secure; HttpOnly; SameSite=Lax`.

**Environment variables tied to domains**

| Variable | Set in | Production value |
| --- | --- | --- |
| `APP_ORIGIN` | Koyeb (API) | `https://eduujoy.aindrajaya.my.id,https://staging.eduujoy.aindrajaya.my.id` (comma-separated CORS and CSRF allow-list) |
| `API_PUBLIC_URL` | Koyeb (API) | `https://api.eduujoy.aindrajaya.my.id` (OAuth redirects, problem `type` URLs) |
| `GOOGLE_OAUTH_REDIRECT_URI` | Koyeb + Google Cloud console | `https://api.eduujoy.aindrajaya.my.id/v1/auth/google/callback` |
| Lemon Squeezy webhook URL | Lemon Squeezy dashboard | `https://api.eduujoy.aindrajaya.my.id/v1/billing/webhook` |
| `VITE_API_URL` | Vercel (UI), per environment | `https://api.eduujoy.aindrajaya.my.id` |
| Local development | `.env` files | UI `http://localhost:5173`, API `http://localhost:3000`; `localhost` on any port counts as the same site |

**Rules**

- Never add `api.eduujoy` to a Vercel project; it is a DNS record only, or Vercel will serve it instead of Koyeb.
- The specific `api.eduujoy` record overrides any `*.aindrajaya.my.id` wildcard pointing to Vercel.
- If `dig NS aindrajaya.my.id +short` does not show Vercel nameservers, create the same record at the registrar instead.
- If the certificate stays pending, check CAA records on the domain and allow Let's Encrypt, Google PKI, DigiCert and Comodo for `issue` and `issuewild`.
- Random `*.vercel.app` preview URLs are cross-site, so sign-in does not work there; use them for visual review only and test auth on `staging.`.

Sources: [Koyeb — Domains](https://www.koyeb.com/docs/run-and-scale/domains) · [Vercel — Pointing subdomains to external services](https://vercel.com/knowledge/pointing-subdomains-to-external-services)

## 4. Domain modules

Nine bounded contexts, each a Nest module that talks to the others only through its public application service or through domain events. No module imports another module's repository or tables.

| Module | Owns | Publishes | Master PRD FRs |
| --- | --- | --- | --- |
| `identity` | Users, sessions, roles, OAuth | `UserRegistered` | FR-23 (sign-in) |
| `catalog` | Topics, aliases, topic embeddings, resolution | `TopicResolved` | FR-01, FR-02 |
| `assessment` | Diagnostic items, attempts, placement, checkpoints, grading | `PlacementComputed`, `CheckpointGraded` | FR-03 to FR-05, FR-17 to FR-19 |
| `discovery` | Resources, ResourceCards, liveness, resource embeddings | `ResourcesReady`, `ResourceDead` | FR-06 to FR-12 |
| `pathing` | Paths, steps, SOP generation, validation, swaps | `PathGenerated`, `StepCompleted`, `StageAdvanced` | FR-13 to FR-16, FR-22 |
| `progress` | Learner positions, history, reports, feedback | `ProgressUpdated` | FR-20, FR-22 |
| `billing` | Lemon Squeezy webhooks, plans, entitlements, credit ledger | `EntitlementChanged` | FR-23 (billing) |
| `admin` | Review queue, cost and latency views | — | FR-24, FR-25 |
| `realtime` | SSE streams, WebSocket gateway, presence | — (subscribes only) | US-09, progress UX |

Shared kernel (`/src/shared`): `ai` adapters behind ports, `jobs` (queue port and executor), `cache` port, `config` (Zod-validated env), `db` (Drizzle client), `common` (guards, filters, interceptors, decorators, problem+json).

**Layering rules inside each module**

1. `domain/`: entities, value objects (`DreyfusStage`, `BloomLevel`, `Position`), domain services and events. Pure TypeScript, no Nest or Drizzle imports.
2. `application/`: use cases (one class per command or query), ports (interfaces), DTO-to-command mapping.
3. `infrastructure/`: Drizzle repositories, AI and HTTP adapters, job handlers.
4. `interface/`: controllers, gateways, request and response DTOs.
5. Dependencies point inward only; an ESLint boundaries rule fails CI on violations.

```text
src/
  main.ts
  app.module.ts
  shared/
    ai/            # ports: VideoAnalyzer, WebDiscovery, VideoSearch, PaperSearch, Embedder, PathDesigner, Grader
    cache/  common/  config/  db/  jobs/
  modules/
    pathing/
      domain/          # path.entity.ts, step.vo.ts, path-generated.event.ts
      application/     # generate-path.usecase.ts, swap-resource.usecase.ts, ports/
      infrastructure/  # path.repository.ts, generate-path.job.ts
      interface/       # paths.controller.ts, dto/
      pathing.module.ts
    identity/  catalog/  assessment/  discovery/  progress/  billing/  admin/  realtime/
  prompts/             # path-designer/v1.md, grader/v1.md, ... (versioned)
test/                  # e2e specs, fixtures (recorded AI responses)
```

## 5. Event-driven flow

State changes write a job row in the same transaction, so the job row doubles as the outbox: a crash never loses work, and the executor resumes unfinished jobs on boot.

&#91;embedded content: path generation sequence · 5 participants\]

Gemini runs only when the topic's resource pool is stale; for cached topics the job goes straight to Claude, which is why warm paths finish in under 25 s.

**Domain events**

| Event | Emitted by | Consumers | Effect |
| --- | --- | --- | --- |
| `PlacementComputed` | assessment | pathing, progress | Enqueue `discover-resources` (if topic pool is stale) or `generate-path`; record position |
| `ResourcesReady` | discovery | pathing | Enqueue `generate-path` for waiting requests on that topic and stage |
| `PathGenerated` | pathing | realtime, progress | Push `path.ready` to the learner; start step 1 |
| `CheckpointGraded` | assessment | pathing, progress, realtime | Advance, retry or insert remedial step; update position; push result |
| `StageAdvanced` | pathing | assessment, realtime | Enqueue re-assessment; notify learner |
| `ResourceDead` | discovery | pathing | Swap the resource in affected open paths |
| `EntitlementChanged` | billing | identity, realtime | Refresh quota cache; push plan change |

**Jobs**

| Job | Concurrency | Timeout | Retries | Idempotency key |
| --- | --- | --- | --- | --- |
| `discover-resources` | 2 | 120 s | 3, exponential backoff with jitter | `topicId:stage:poolVersion` |
| `analyse-resource` | 2 | 180 s (streaming) | 2 | `url:promptVersion` |
| `generate-path` | 2 | 90 s | 2, then admin review | `userId:topicId:placementId` |
| `grade-checkpoint` | 4 | 30 s | 2 | `submissionId` |
| `check-liveness` (daily) | 4 | 10 s per URL | 1 | `resourceId:date` |

**Rules**

- Job state: `queued → running → succeeded | failed | dead`; each transition and every progress tick is persisted and fanned out to SSE subscribers.
- Handlers are idempotent: re-running a job with the same key returns the stored result.
- Events are emitted only after commit (`afterCommit` hook); handlers never run inside the publisher's transaction.
- A daily budget guard rejects new cold-topic jobs once AI spend passes `AI_DAILY_BUDGET_USD`; cached-topic paths still run.

## 6. Auth, Guards and RBAC

Sessions live only in HttpOnly cookies, so the UI and API share one registrable domain, `aindrajaya.my.id`: the UI at `https://eduujoy.aindrajaya.my.id` (Vercel) and the API at `https://api.eduujoy.aindrajaya.my.id` (Koyeb, via a CNAME record; setup in Section 3). On the default `*.vercel.app` and `*.koyeb.app` hosts the cookies would be third-party, and Safari and Chrome block or restrict those. Environment: `APP_ORIGIN (allow-list in Section 3)`; cookies are host-only on the API host (no `Domain` attribute).

**Session model**

| Cookie | Content | Lifetime | Attributes |
| --- | --- | --- | --- |
| `ej_at` | Access JWT (user ID, roles, plan, session ID) | 15 min | `HttpOnly; Secure; SameSite=Lax; Path=/` |
| `ej_rt` | Opaque refresh token; only its hash is stored in `sessions` | 30 days, rotated on every use | `HttpOnly; Secure; SameSite=Lax; Path=/v1/auth` |

- Sign-in methods: email + password (argon2id) and Google OAuth (authorization code flow with PKCE, handled by the API).
- Refresh-token reuse (an old token presented again) revokes the whole session family.
- `GET /v1/auth/me` is the UI's single source of session truth; tokens never reach JavaScript.
- Logout clears both cookies and revokes the session row.

**Guard chain** (global, in this order)

1. `ThrottlerGuard` (`@nestjs/throttler`): 100 req/min per IP by default; 5/min on login; 5/hour on path generation per user.
2. `CsrfGuard`: for unsafe methods, require an `Origin` header matching `APP_ORIGIN` and an `X-Requested-With: eduujoy` header. With `SameSite=Lax` this blocks cross-site form posts.
3. `JwtAuthGuard`: reads `ej_at`; routes marked `@Public()` skip it.
4. `RolesGuard`: `@Roles('admin')` style checks against the JWT roles.
5. `PolicyGuard`: resource ownership through `@CheckPolicy(PathOwnerPolicy)` (e.g. `path.userId === user.id`, or role `reviewer` for review-queue items).
6. `EntitlementGuard`: `@RequiresEntitlement('path.generate')` checks plan quota or credit balance before expensive work.

**Roles and permissions**

| Permission | learner | reviewer | admin |
| --- | --- | --- | --- |
| Own diagnostics, paths, checkpoints, progress | ✓ | ✓ | ✓ |
| Generate paths (within entitlement) | ✓ | ✓ | ✓ |
| Review queue: read and resolve flagged items | — | ✓ | ✓ |
| Edit diagnostic items, topics, domain allow/deny lists | — | ✓ | ✓ |
| Cost and latency dashboard, user management, budget settings | — | — | ✓ |

**CORS:** allow only `APP_ORIGIN`, `credentials: true`, methods `GET, POST, PATCH, DELETE`, and expose `X-Request-Id`.

## 7. API contract

All routes live under `/v1`, every input is a validated DTO, every error is `application/problem+json`, and `openapi.json` is generated on each build so the UI repo can regenerate its types.

**Endpoints (MVP)**

| Method and path | Purpose | Auth | Notes |
| --- | --- | --- | --- |
| `POST /v1/auth/register` · `/login` · `/logout` · `/refresh` | Email sessions | Public (logout: user) | Sets or clears cookies |
| `GET /v1/auth/google` · `/google/callback` | Google OAuth | Public | Redirects back to `APP_ORIGIN` |
| `GET /v1/auth/me` | Session bootstrap | User | User, roles, plan, remaining quota |
| `POST /v1/topics/resolve` | Canonical topic or ≤ 3 choices | User | Vector search on topic embeddings |
| `POST /v1/diagnostics` | Start a diagnostic for a topic | User | Returns first item batch (4 items) |
| `POST /v1/diagnostics/:id/answers` | Submit a batch of answers | Owner | Returns next batch or the placement |
| `POST /v1/paths` | Request a path | Owner + entitlement | `202 Accepted` with `jobId`; `Idempotency-Key` header required |
| `GET /v1/jobs/:id/events` | Job progress stream | Owner | SSE, see Section 9 |
| `GET /v1/paths` · `/v1/paths/:id` | List and read paths | Owner | `ETag`; `304` on match |
| `PATCH /v1/steps/:id` | Mark actions done, rate difficulty | Owner | Partial update |
| `POST /v1/checkpoints/:id/submissions` | Batch-submit all answers for a checkpoint | Owner | `Idempotency-Key`; returns `202` + `jobId` for open answers, `200` for auto-graded |
| `POST /v1/resources/:id/swap` · `POST /v1/feedback` | Swap a resource, thumbs and flags | Owner | — |
| `GET /v1/progress` · `/v1/progress/:topicId/history` | Grid position and history | Owner | — |
| `POST /v1/billing/checkout` · `POST /v1/billing/webhook` | Lemon Squeezy checkout link and webhooks | User · Public (signature-verified) | Webhook verifies `X-Signature` HMAC |
| `GET /v1/admin/review-queue` · `PATCH /v1/admin/review-queue/:id` | Review flagged items | reviewer | — |
| `GET /v1/admin/metrics/cost` · `/latency` | Cost and latency per stage and model | admin | — |
| `GET /health` · `/ready` | Liveness and readiness | Public | Readiness checks DB |

**Validation rules**

- Global `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })`; no implicit type conversion.
- Every DTO declares bounds: string max lengths (topic ≤ 120 chars, open answer ≤ 4,000 chars), array sizes (≤ 50 answers per batch), enums for stage and Bloom level.
- Response DTOs are explicit classes serialised with `ClassSerializerInterceptor`; entities are never returned directly.
- AI outputs are parsed with Zod schemas that mirror the ResourceCard and Path contracts in the master PRD; a parse failure counts as a job failure.

JSON field names are camelCase in every request and response (decision, 21 Oct 2026). The snake\_case shapes in master PRD Section 8 describe internal model output; adapters map them before anything leaves the API. The frozen contract is `docs/contract/openapi.v0.yaml` in the workspace root; only the lead session edits it.

**Error format** (RFC 9457 problem details)

```json
{
  "type": "https://api.eduujoy.aindrajaya.my.id/problems/quota-exceeded",
  "title": "Monthly path quota reached",
  "status": 402,
  "detail": "Your plan includes 4 paths per month. Buy a credit pack or wait until 1 Nov.",
  "code": "QUOTA_EXCEEDED",
  "requestId": "req_01HF...",
  "errors": []
}
```

Validation failures return `400` with `errors: [{ field, message }]`; the UI maps them onto form fields.

## 8. Data model, embeddings and similarity search

The master PRD's tables stand; the API adds session, job, submission and billing tables, plus `vector(768)` columns on topics and resource cards with HNSW cosine indexes.

**Tables added for the API** (beyond master PRD Section 9)

| Table | Key fields |
| --- | --- |
| `sessions` | id, user\_id, family\_id, refresh\_hash, user\_agent, ip\_hash, expires\_at, revoked\_at |
| `user_roles` | user\_id, role (learner, reviewer, admin) |
| `jobs` | id, type, idempotency\_key (unique), payload (jsonb), status, progress (jsonb), attempts, run\_after, result (jsonb), error, created\_at, updated\_at |
| `checkpoint_submissions` | id, step\_id, user\_id, idempotency\_key (unique), answers (jsonb), status, score, graded\_at |
| `entitlements` | user\_id, plan, monthly\_path\_quota, period\_start, period\_end |
| `credit_ledger` | id, user\_id, delta, reason (purchase, path, refund), external\_ref, created\_at |
| `billing_events` | id, provider\_event\_id (unique), type, payload (jsonb), processed\_at |

**Embeddings**

- Model: `gemini-embedding-2` with `output_dimensionality: 768`; it normalises truncated vectors itself and accepts up to 8,192 input tokens ([Gemini embeddings](https://ai.google.dev/gemini-api/docs/embeddings)).
- Text embedded: topics (canonical name + aliases + one-line description); ResourceCards (title + key takeaways + concepts). Raw transcripts are never embedded or stored.
- Indexes: `CREATE INDEX ... USING hnsw (embedding vector_cosine_ops)` on `topics` and `resource_cards`.
- `embedding_model` and `embedding_version` columns on each row allow re-embedding without downtime.

**Similarity use cases**

| Use case | Query | Threshold (start values, tune on golden set) |
| --- | --- | --- |
| Topic resolution (FR-02) | Nearest topics to the learner's text | ≥ 0.88 auto-match; 0.75–0.88 offer ≤ 3 choices; below, create a new topic |
| Resource dedupe | Nearest card in the same topic | ≥ 0.95 treated as duplicate; keep the higher quality score |
| Resource swap (US-07) | Same topic, same stage, overlapping Bloom tags, not disliked by this user | Top 3 by cosine × quality |
| Remedial step resource | Same concept, one Bloom level lower | Top 1 not already in the path |

```sql
SELECT rc.resource_id, 1 - (rc.embedding <=> $1) AS similarity
FROM resource_cards rc
WHERE rc.topic_id = $2
  AND rc.dreyfus_stage = $3
  AND rc.bloom_levels && $4
  AND rc.resource_id <> ALL($5)
ORDER BY rc.embedding <=> $1
LIMIT 3;
```

## 9. Real-time: SSE and WebSockets

SSE carries one job's progress to the screen that started it. The WebSocket gateway carries user-level notifications to every open tab. Both read from the same in-process event bus.

| Channel | Transport | Used for | Auth |
| --- | --- | --- | --- |
| `GET /v1/jobs/:id/events` | SSE (`text/event-stream`) | Path generation, open-answer grading, re-assessment progress | Cookie; job owner only |
| `/realtime` namespace | Socket.IO over WebSocket, long-poll fallback | `path.ready`, `checkpoint.graded`, `stage.advanced`, `entitlement.changed`, admin review-queue counts | Cookie checked in the handshake; joins room `user:{id}` (and `role:reviewer`) |

**SSE event shape**

```text
id: 17
event: progress
data: {"jobId":"job_9x","stage":"analyse","done":4,"total":6,"message":"Analysing videos (4 of 6)"}

event: completed
data: {"jobId":"job_9x","resultRef":"/v1/paths/path_19c2"}
```

- Event types: `progress`, `partial` (e.g. the first SOP step is ready before the rest), `completed`, `failed`.
- On connect, the server replays every event after `Last-Event-ID` from the job's stored progress, so a reload or reconnect never loses state.
- Heartbeat comment every 20 s; the server closes the stream after `completed` or `failed`.
- Response headers: `Cache-Control: no-cache`, `X-Accel-Buffering: no`.

**WebSocket rules**

- Server → client only in the MVP; client → server messages are limited to `ack` and `subscribe:topic`, validated with DTOs in a `WsValidationPipe`.
- Ping every 25 s, timeout 60 s. The client reconnects with exponential backoff (1 s to 30 s).
- A single Socket.IO server instance in the MVP; add `@socket.io/redis-adapter` when a second API instance appears.
- An open socket keeps the Koyeb free instance awake. The UI therefore opens the socket only while the tab is visible and closes it after 5 min hidden.

## 10. Caching layers

Caching exists to cut AI spend first and latency second: the expensive layer is the persistent cache of analysed resources, not an in-memory store.

| Layer | Store | What | TTL | Invalidated by |
| --- | --- | --- | --- | --- |
| L0 provider | Claude prompt cache | System prefix: Dreyfus × Bloom rubric, schemas, few-shot examples | 5 min (1 h for nightly batches) | Prompt version change |
| L1 in-process | `lru-cache` behind the `CacheStore` port | Topic lookups, `auth/me` payload, entitlement checks, domain allow/deny lists | 30–120 s | Domain events (`EntitlementChanged`, topic edits) |
| L2 persistent | Postgres tables | ResourceCards (by URL + prompt version) | 30 days | `ResourceDead`, prompt version bump |
| L2 persistent | Postgres tables | YouTube video metadata | ≤ 30 days, then refreshed or deleted | Daily liveness job |
| L2 persistent | Postgres tables | Discovery result sets per topic + stage | 7 days (pending the grounding-terms review in the master PRD) | Manual refresh, low feedback scores |
| HTTP | `ETag` + `Cache-Control: private, no-cache` | `GET /v1/paths/:id`, `/v1/progress` | Revalidate every request | Any write to the resource |

- Cache keys are namespaced and versioned, e.g. `topic:v1:{slug}`, `ent:v1:{userId}`.
- Never cache across users anything derived from a user's answers.
- Redis (Upstash) replaces L1 only when a second instance exists; the `CacheStore` port keeps that a configuration change.

## 11. AI integration

Gemini watches and searches, Claude designs and grades, and every vendor sits behind a port so a model or source can change without touching use cases.

**Ports and adapters**

| Port | Adapter (MVP) | Model or API | Notes |
| --- | --- | --- | --- |
| `VideoSearch` | `YouTubeDataApiAdapter` | YouTube Data API v3, Google API key | `search.list` costs 100 of 10,000 daily units, so about 100 searches/day; cache per topic + stage |
| `VideoAnalyzer` | `GeminiVideoAdapter` | `gemini-3.8-flash`, YouTube URL input, agentic mode | Streams; produces ResourceCards with timestamp ranges and English output for non-English videos |
| `WebDiscovery` | `GeminiGroundingAdapter` | `gemini-3.8-flash` + Google Search grounding | Articles and official docs; paid Gemini tier only; terms review pending (master PRD) |
| `PaperSearch` | `OpenAlexAdapter` | OpenAlex API (free), arXiv fallback | Verify usage terms in slice A7 |
| `TextAnalyzer` | `GeminiTextAdapter` | `gemini-3.5-flash-lite` | Tags articles, docs and paper abstracts |
| `Embedder` | `GeminiEmbeddingAdapter` | `gemini-embedding-2`, 768 dims | Batched; Batch API at half price for backfills |
| `TopicNormalizer` · `ItemWriter` | `ClaudeHaikuAdapter` | `claude-haiku-5-5` | Short, high-volume calls |
| `PathDesigner` · `Grader` | `ClaudeSonnetAdapter` | `claude-sonnet-5-5`, structured JSON output | Grader uses Haiku for C1–C3, Sonnet for C4–C6 |

**Why Gemini for YouTube, not Claude:** Gemini accepts a public YouTube URL directly and reads both the audio track and the frames; Claude's API cannot fetch or watch a YouTube video. Gemini can also summarise a non-English video in English, which covers the "translate" need.

**Not usable:** Google's Custom Search JSON API is closed to new customers and stops working on 1 Jan 2027 ([Brave summary, competitor source](https://brave.com/learn/google-api-shutdown/)), so the Google API key is used only for the YouTube Data API.

**Prompt and call rules**

- Prompts live in `src/prompts/<name>/v<n>.md`; each call records `prompt_name`, `prompt_version`, model, tokens, cost, latency in `llm_calls`.
- Timeouts: Gemini video 180 s (streamed), Gemini text 30 s, Claude Sonnet 90 s, Claude Haiku 20 s; 2 retries on 429/5xx with jitter; never retry 4xx validation errors.
- Untrusted content (pages, transcripts) goes in a delimited data block; the system prompt states it is data, not instructions.
- Recorded fixtures (`test/fixtures/ai/*.json`) let CI run without API keys.

**Claude API credit plan: US$100 per billing cycle (Max 5x subscriber credits)**

The Max 5x plan includes US$100 of Claude API credits each billing cycle. They cover the Claude API (Messages and Batch), the Agent SDK and `claude -p` run with an API key, but **not** interactive Claude Code, which runs on the Max plan itself. Unused credits do not roll over, so this cycle's balance (to 4 Nov) goes to seed data that stays useful afterwards. Run everything from a `tools/seed` script with the Anthropic SDK, use the Batch API (half price) for bulk work, and commit outputs as JSON under `seed/`. Prerequisite: link the Max plan to a Console organization (claude.ai → Settings → Billing → API credits → Link organization) and create `ANTHROPIC_API_KEY` in that organization, inside a workspace with a US$100 spend limit.

| Window | Task | Model and mode | Volume | Est. cost (US$) |
| --- | --- | --- | --- | --- |
| 22–24 Oct | Prompt development for `PathDesigner` and `Grader` | Sonnet 5.5, standard | Interactive iterations | 20 |
| 25 Oct | Seed topic taxonomy: names, aliases, descriptions, prerequisite edges | Sonnet 5.5, Batch | 150 topics (50 software, 50 STEM, 50 non-technical) | 3 |
| 26 Oct | Concept maps: learning objectives per Dreyfus stage × Bloom band | Sonnet 5.5, Batch | 150 topics | 5 |
| 27–28 Oct | Diagnostic item banks with rubrics | Sonnet 5.5, Batch | 150 topics × 72 items | 20 |
| 29 Oct | Item quality review (LLM judge, cached rubric) | Sonnet 5.5, Batch + prompt cache | \~10,800 items | 18 |
| 30 Oct | Golden-set draft paths and rubrics for in-house review | Sonnet 5.5, Batch | 90 cases | 5 |
| 31 Oct–2 Nov | Eval runs: LLM judge across prompt versions | Sonnet 5.5, Batch | 90 cases × 5 versions | 10 |
| 3 Nov | Reruns and fixes from review | Mixed | — | 12 |
| **Total** |  |  |  | **93** |

Later cycles fund prompt evals and early production API calls from the same linked organization. When a cycle's credits run out and no purchased credits exist, API requests stop until the next grant, so production needs purchased credits or auto-reload before launch.

## 12. Non-functional requirements

The API inherits the master PRD's targets (Section 10) and adds service-level budgets that CI and dashboards can check.

**Performance**

| Endpoint class | p95 target (warm instance) |
| --- | --- |
| `GET` reads (paths, progress, me) | ≤ 150 ms |
| Writes without AI (feedback, step updates) | ≤ 250 ms |
| Diagnostic answer batch (auto-graded) | ≤ 400 ms |
| `POST /v1/paths` (returns `202`) | ≤ 300 ms |
| First SSE `progress` event after `202` | ≤ 2 s |

Cold start on the free instance adds 1–5 s; the UI covers it with a wake-up state.

**Security**

- Secrets only in Koyeb environment variables; `.env.example` lists keys without values; Zod validates env at boot and the app refuses to start on missing keys.
- `helmet` defaults; no `X-Powered-By`; request body limit 256 KB.
- Lemon Squeezy webhooks: verify HMAC signature, dedupe by `provider_event_id`, process in a job.
- Passwords: argon2id; account lockout after 10 failed logins in 15 min.
- Personal data export (`GET /v1/me/export`) and deletion (`DELETE /v1/me`) endpoints for GDPR-level compliance.
- Dependency audit (`pnpm audit`) and CodeQL in CI.

**Observability**

- Every request gets `X-Request-Id`; logs are JSON with `requestId`, `userId`, `route`, `latencyMs`.
- Each job logs stage timings; `llm_calls` feeds the admin cost dashboard (FR-25).
- Alerts (Sentry): error rate > 2% over 5 min, job failure rate > 10% per hour, daily AI spend > 80% of budget.

**Testing**

| Level | Tool | Gate |
| --- | --- | --- |
| Unit (domain + use cases) | Jest | ≥ 80% line coverage on `domain/` and `application/` |
| Integration (repositories, vector queries) | Jest against the Neon test branch; each run uses its own schema (no Docker) | All pass |
| e2e (HTTP, guards, SSE) | Supertest against the app with recorded AI fixtures | All pass |
| Contract | `openapi.json` diff in CI | Breaking changes need a version bump |
| AI quality | Golden-set eval script (master PRD Section 11) | Mean ≥ 4.0 before prompt changes merge |

**Databases (decided 21 Oct 2026, no local Docker)**

| Neon project | Region | Branch | Used by | Variable |
| --- | --- | --- | --- | --- |
| `eduujoy-prod` | AWS Frankfurt (next to Koyeb) | `main` | Production API | `DATABASE_URL`, `DATABASE_URL_DIRECT` in Koyeb |
| `eduujoy-dev` | AWS Singapore (close to the developer) | `main` | Local development | `DATABASE_URL`, `DATABASE_URL_DIRECT` in `.secrets.env` |
| `eduujoy-dev` | AWS Singapore | `test` | Integration and e2e tests, locally and in CI | `DATABASE_URL_TEST` (direct string, never pooled) |

- Tests use the direct connection because `SET search_path` does not survive the pooler's transaction mode.
- The test harness refuses to run unless `DATABASE_URL_TEST` differs from `DATABASE_URL` and `DATABASE_URL_DIRECT`, and it only creates or drops schemas named `test_*`.
- `pgvector` is installed once in the `public` schema of each branch; per-run schemas keep `public` on their search path.
- A cleanup step drops `test_*` schemas older than 24 hours, so crashed runs do not pile up.
- The Dockerfile is built and smoke-tested only in CI and on Koyeb.

## 13. Build plan for Claude Code

Fourteen slices, each sized for one Claude Code session and one pull request, in dependency order. A slice is done only when its verification commands pass.

| ID | Slice | Covers | Done when | Verify |
| --- | --- | --- | --- | --- |
| A0 | Repo bootstrap: Nest app, strict TS, ESLint boundaries rule, Zod env config, pino, helmet, health endpoints, Dockerfile, CI | — | App deploys to Koyeb and serves at api.eduujoy.aindrajaya.my.id with a valid certificate; `/health` returns 200 | `pnpm lint && pnpm test && pnpm build`; `curl /health` |
| A1 | Database: Drizzle schema for all master + API tables, `pgvector` extension, HNSW indexes, seed loader for `seed/*.json` | Data model | Migrations apply on a Neon branch; seed loads 150 topics | `pnpm db:migrate && pnpm db:seed`; integration tests |
| A2 | Identity: register, login, refresh rotation, logout, Google OAuth, `auth/me`, guard chain, roles | FR-23, Section 6 | Cookies set with correct flags; reuse detection revokes family | e2e: `auth.e2e-spec.ts` |
| A3 | Contract layer: `ValidationPipe`, problem+json filter, serializer, Swagger export, request IDs | Section 7 | `openapi.json` committed; invalid DTO returns 400 with field errors | `pnpm openapi:check` |
| A4 | AI shared kernel: ports, Claude and Gemini adapters, `llm_calls` metering, budget guard, fixtures | Section 11 | Adapters pass contract tests offline | `pnpm test ai` |
| A5 | Jobs and events: `jobs` table, executor, resume on boot, event bus with `afterCommit` | Section 5 | Killed process resumes a running job | `jobs.int-spec.ts` |
| A6 | Catalog: topic resolve with embeddings and thresholds | FR-01, FR-02 | Golden topic phrases resolve correctly ≥ 95% | `catalog.e2e-spec.ts` |
| A7 | Assessment I: diagnostic sessions, adaptive item batches, placement | FR-03, FR-04 | Placement matches expected for fixture learners | `diagnostic.e2e-spec.ts` |
| A8 | Discovery: YouTube search, OpenAlex, grounding, liveness, analysis, ResourceCards, dedupe | FR-06 to FR-12 | 10 fixture topics yield ≥ 3 resource types each, 0 dead links | `discovery.int-spec.ts` + live smoke script |
| A9 | Pathing: SOP generation, validator, regenerate-once, SSE stream | FR-13 to FR-15, Section 9 | Golden-set mean ≥ 4.0 on the eval script; SSE replay works | `pnpm eval:paths`; `paths.e2e-spec.ts` |
| A10 | Assessment II: checkpoint batch submission, auto and AI grading, remedial insertion | FR-16 to FR-18 | Two fails insert a remedial step | `checkpoints.e2e-spec.ts` |
| A11 | Progress and realtime: positions, history, WebSocket gateway, feedback, swap | FR-20, FR-22, US-07 | Second tab receives `checkpoint.graded` | `realtime.e2e-spec.ts` |
| A12 | Billing: Lemon Squeezy checkout, webhooks, entitlements, credit ledger | FR-23 | Replayed webhook is ignored; quota blocks generation | `billing.e2e-spec.ts` |
| A13 | Admin and hardening: review queue, cost and latency endpoints, export and delete, load test | FR-24, FR-25 | p95 targets met at 20 concurrent users | `k6 run load/smoke.js` |

**Starter `CLAUDE.md` for the API repo**

```markdown
# Eduujoy API (NestJS)
Specs: ../docs/PRD-MASTER.md (product, wins on conflict) and docs/PRD-API.md (implementation).
- Implement exactly one slice from PRD-API Section 13 per session; branch slice/A<n>-<name>; commit prefix `api:`.
- Run git, pnpm and tests from inside api/ (separate repo).
- Respect module boundaries (PRD-API Section 4); never import another module's infrastructure.
- Every input is a DTO with class-validator bounds; every AI output is parsed with Zod.
- After changing a DTO or route, run `pnpm openapi:export` so api/openapi.json stays current.
- Run the slice's Verify commands; do not mark done until they pass.
- If the PRD is ambiguous, stop and list the question instead of guessing.
```

## 14. Open questions

- [ ] Does Koyeb's free instance accept the custom domain `api.eduujoy.aindrajaya.my.id`? If not, use the cheapest paid instance, or proxy REST and SSE through a Vercel rewrite and run Socket.IO on long-polling.
- [ ] Link the Max plan to the Console organization and confirm the US$100 appears under Promotional credits on the Console Billing page before 24 Oct.
- [ ] OpenAlex and arXiv usage terms for storing paper metadata (check in slice A8).
- [ ] Grounding-terms review outcome (master PRD Section 14); it decides whether the discovery cache in Section 10 may be shared across learners.

## Sources

- [Koyeb — Pricing FAQ](https://www.koyeb.com/docs/faq/pricing)
- [Koyeb — Scale to zero](https://www.koyeb.com/docs/run-and-scale/scale-to-zero)
- [Neon — Free plan limits](https://neon.com/faqs/free-plan-limits-and-quotas)
- [Gemini API — Embeddings](https://ai.google.dev/gemini-api/docs/embeddings)
- [Gemini API — Video understanding](https://ai.google.dev/gemini-api/docs/generate-content/video-understanding)
- [Gemini Developer API pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [Claude API pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [YouTube Data API — Quota costs](https://developers.google.com/youtube/v3/determine_quota_cost)
- [Brave — Google Search API shutdown (competitor source)](https://brave.com/learn/google-api-shutdown/)
