import { Pool } from 'pg';
import { GeminiResourceAnalyzer } from '../../src/modules/discovery/infrastructure/gemini-resource-analyzer';
import { YouTubeDataApiAdapter } from '../../src/modules/discovery/infrastructure/youtube-data-api.adapter';
import { videoPlan, videoTokens, youtubeIdFromUrl } from '../../src/modules/discovery/domain';
import { costUsd, PromptRegistry } from '../../src/shared/ai';
import { ClaudeStructuredGenerator } from '../../src/shared/ai/claude/claude.generator';
import { createGeminiClient, GeminiStructuredGenerator } from '../../src/shared/ai/gemini/gemini.adapters';
import { DrizzleLlmCallRecorder } from '../../src/shared/ai/metering/llm-call.recorder';
import { MeteredStructuredGenerator } from '../../src/shared/ai/metering/metered';
import { TallyingRecorder } from '../../src/shared/ai/metering/tallying.recorder';
import { createDatabase } from '../../src/shared/db';
import { loadDirectDatabaseUrl } from '../../src/shared/db/cli/env';
import { guardPool, POOL_SETTINGS } from '../../src/shared/db/db.module';
import { describeError } from '../../src/shared/db/redact';
import Anthropic from '@anthropic-ai/sdk';

// Run by the user, once: `pnpm discovery:verify-video [youtubeUrl]` (node --env-file=.env), against
// eduujoy-dev. One Gemini analysis of one video at the frame rate the A8 cap plans, to check that Gemini
// honours videoMetadata.fps for YouTube URLs (lead review, 23 Oct 2026). The default video is the 29-minute
// one the set-B smoke analysed at 1 fps for 154,881 input tokens; planned at 0.5 fps it should come in
// near the 0.5 fps estimate if fps is honoured, and near 155k if it is ignored. Refuses to run when the
// estimated cost is over US$0.15. The call is metered into llm_calls. Keys come from process.env only.
// Wired by hand: tsx emits no decorator metadata.

const DEFAULT_URL = 'https://www.youtube.com/watch?v=-YFVJkgLzCI';
const MAX_USD = 0.15;
const MEASURED_AT_1_FPS = 154_881;

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be in the environment (run with node --env-file=.env)`);
  return value;
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const url = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? DEFAULT_URL;
  const id = youtubeIdFromUrl(url);
  if (!id) throw new Error(`Not a YouTube video URL: ${url}`);
  const gemini = createGeminiClient(check ? 'check' : env('GEMINI_API_KEY'));
  const pool = guardPool(new Pool({ connectionString: check ? 'postgresql://check@localhost/check' : loadDirectDatabaseUrl(), ...POOL_SETTINGS }), (m) => {
    process.stderr.write(`discovery:verify-video: ${m}\n`);
  });
  const meter = new TallyingRecorder(new DrizzleLlmCallRecorder(createDatabase(pool)), { detachJobs: true });
  const generator = new MeteredStructuredGenerator({ anthropic: new ClaudeStructuredGenerator(new Anthropic({ apiKey: 'unused' })), google: new GeminiStructuredGenerator(gemini) }, meter);
  const analyzer = new GeminiResourceAnalyzer(generator, new PromptRegistry());
  if (check) {
    process.stdout.write(`discovery:verify-video: ok (${analyzer.constructor.name})\n`);
    return;
  }
  try {
    const [video] = await new YouTubeDataApiAdapter(env('YOUTUBE_API_KEY')).details([id]);
    if (!video) throw new Error(`videos.list does not know ${id}`);
    const plan = videoPlan(video.durationMin);
    if (plan.action === 'skip') throw new Error(`The plan skips this video (${plan.reason}); pick one of 20-55 minutes`);
    const estimatedUsd = costUsd('gemini-3.8-flash', { inputTokens: plan.estimatedTokens, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 2_500 }, new Date());
    process.stdout.write(`${url}: ${video.durationMin} min, planned at ${plan.fps} fps${plan.endSec ? `, clipped at ${plan.endSec} s` : ''}; estimated ${plan.estimatedTokens} input tokens, ~$${estimatedUsd.toFixed(4)}\n`);
    if (estimatedUsd > MAX_USD) throw new Error(`Estimated $${estimatedUsd.toFixed(4)} is over the $${MAX_USD} stop; pick a shorter video`);

    const analysis = await analyzer.analyse({
      kind: 'video',
      topic: { id: 'verify', name: video.title, description: null, domain: null },
      poolStage: 'competent',
      url,
      title: video.title,
      source: video.channel,
      durationMin: video.durationMin,
      content: null,
      clip: { fps: plan.fps, endSec: plan.endSec },
    });
    const seconds = plan.endSec ?? video.durationMin * 60;
    const atOneFps = videoTokens(seconds, 1);
    const honoured = analysis.inputTokens < (plan.estimatedTokens + atOneFps) / 2;
    const summary = {
      url,
      durationMin: video.durationMin,
      fps: plan.fps,
      estimatedTokens: plan.estimatedTokens,
      estimatedTokensAt1Fps: atOneFps,
      actualInputTokens: analysis.inputTokens,
      ...(url === DEFAULT_URL ? { measuredAt1FpsInSmoke: MEASURED_AT_1_FPS } : {}),
      costUsd: Math.round(meter.total * 1_000_000) / 1_000_000,
      verdict: honoured ? 'fps honoured: real tokens near the lower-fps estimate' : 'fps NOT honoured: real tokens near the 1 fps estimate',
      recordFailures: meter.failures,
    };
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    if (meter.failures > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`discovery:verify-video failed: ${describeError(error)}\n`);
  process.exitCode = 1;
});
