import { Controller, Get, Headers, Inject, Param, Req, Res } from '@nestjs/common';
import { ApiHeader, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { type Request, type Response } from 'express';
import { type AuthUser, CurrentUser } from '../common/auth';
import { ApiAccessCookieAuth, ApiProblem } from '../common/openapi';
import { AppConfig } from '../config';
import { ProblemException, toProblem } from '../common/problem/problem';
import { JobExecutor } from './job-executor';
import { JobRepository } from './job.repository';
import { type JobEvent, type JobRecord } from './job.types';

/** Heartbeat and cross-instance poll interval (contract: a heartbeat comment every 20 s). */
export const JOB_EVENTS_HEARTBEAT_MS = Symbol('JOB_EVENTS_HEARTBEAT_MS');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERMINAL_EVENTS = new Set(['completed', 'failed']);

/**
 * `GET /v1/jobs/{id}/events` (contract jobsEvents): Server-Sent Events for one job, owner only.
 * - Replays persisted events after `Last-Event-ID`, then streams live ones. It subscribes before the
 *   replay query and drops duplicates by id, so no event falls in between.
 * - Each heartbeat also re-reads events after the last one sent: during an overlapping deploy the
 *   job may run on the other instance, whose executor this one doesn't hear.
 * - Closes after `completed` or `failed`. A job that is terminal without one (its event write failed)
 *   gets one synthesised from the row (an INTERNAL problem if it failed), so EventSource doesn't reconnect forever.
 * - `jobs.error` never reaches the client; a `failed` event carries only the mapped Problem.
 */
@ApiTags('jobs')
@ApiAccessCookieAuth()
@Controller('v1/jobs')
export class JobEventsController {
  constructor(
    private readonly repo: JobRepository,
    private readonly executor: JobExecutor,
    private readonly config: AppConfig,
    @Inject(JOB_EVENTS_HEARTBEAT_MS) private readonly heartbeatMs: number,
  ) {}

  @Get(':id/events')
  @ApiOperation({ operationId: 'jobsEvents', summary: 'Job progress stream (SSE).' })
  @ApiParam({ name: 'id', schema: { type: 'string', maxLength: 64 } })
  @ApiHeader({ name: 'Last-Event-ID', required: false, schema: { type: 'string' } })
  @ApiOkResponse({
    description: 'Event stream.',
    headers: { 'Cache-Control': { schema: { type: 'string', enum: ['no-cache'] } }, 'X-Accel-Buffering': { schema: { type: 'string', enum: ['no'] } } },
    content: { 'text/event-stream': { schema: { type: 'string' } } },
  })
  @ApiProblem(401)
  @ApiProblem(403)
  @ApiProblem(404)
  async events(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Headers('last-event-id') lastEventId: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const job = UUID.test(id) ? await this.repo.findById(id) : undefined;
    // Someone else's job is indistinguishable from a missing one.
    if (!job || job.userId !== user.userId) throw new ProblemException(404, 'NOT_FOUND', 'Not found');

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    let lastSent = /^\d{1,18}$/.test(lastEventId ?? '') ? Number(lastEventId) : 0;
    let closed = false;
    let draining: Promise<void> = Promise.resolve();
    const pending: JobEvent[] = [];

    const close = (): void => {
      if (closed) return;
      closed = true;
      unsubscribe();
      clearInterval(heartbeat);
      res.end();
    };
    const send = (event: JobEvent): void => {
      if (closed || event.id <= lastSent) return;
      lastSent = event.id;
      res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
      if (TERMINAL_EVENTS.has(event.type)) close();
    };
    // Serialised so a replay and a live event can't interleave out of order.
    const drain = (load?: () => Promise<JobEvent[]>): void => {
      draining = draining
        .then(async () => {
          if (closed) return;
          for (const event of load ? await load() : pending.splice(0)) send(event);
        })
        .catch(() => {
          close();
        });
    };

    const unsubscribe = this.executor.onEvent((event) => {
      if (event.jobId !== job.id || closed) return;
      pending.push(event);
      drain();
    });
    const heartbeat = setInterval(() => {
      if (closed) return;
      res.write(': heartbeat\n\n');
      drain(() => this.repo.eventsAfter(job.id, lastSent));
    }, this.heartbeatMs);
    req.on('close', close);

    drain(() => this.repo.eventsAfter(job.id, lastSent));
    drain(async () => {
      const latest = await this.repo.findById(job.id);
      return latest ? this.synthesiseTerminal(latest) : [];
    });
    await draining;
  }

  /** A terminal job whose terminal event is missing: one event built from the row (sentinel id). */
  private async synthesiseTerminal(job: JobRecord): Promise<JobEvent[]> {
    if (job.status !== 'succeeded' && job.status !== 'dead') return [];
    const all = await this.repo.eventsAfter(job.id, 0);
    if (all.some((e) => TERMINAL_EVENTS.has(e.type))) return [];
    const data =
      job.status === 'succeeded'
        ? { jobId: job.id, ...(job.result as Record<string, unknown>) }
        : {
            jobId: job.id,
            retryable: false,
            problem: toProblem(new Error('terminal event missing'), {
              baseUrl: this.config.env.API_PUBLIC_URL,
              requestId: `job:${job.id}`,
              instance: `/v1/jobs/${job.id}`,
            }).body,
          };
    return [{ id: Number.MAX_SAFE_INTEGER, jobId: job.id, type: job.status === 'succeeded' ? 'completed' : 'failed', data, createdAt: new Date() }];
  }
}
