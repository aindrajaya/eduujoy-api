import type Anthropic from '@anthropic-ai/sdk';
import { closeRun, logSpend, recordOpenRun, reject } from './ledger';
import { addUsage, fromApiUsage, usd, ZERO_USAGE, type Usage } from './pricing';

// Batch API plumbing shared by the seed commands: submit records the batch ID in seed/_state.json before
// anything else can fail, and collect polls, hands each succeeded message to the command, logs the
// actual cost and closes the run. An interrupted command reruns into collect instead of paying twice.

const POLL_MS = 30_000;

export type BatchRequest = Anthropic.Messages.Batches.BatchCreateParams.Request;

export async function submitBatch(client: Anthropic, command: string, promptVersion: string, requests: BatchRequest[]): Promise<string> {
  const created = await client.messages.batches.create({ requests });
  recordOpenRun(command, { batchId: created.id, submittedAt: new Date().toISOString(), requests: requests.length, promptVersion });
  process.stdout.write(`Submitted batch ${created.id} (${requests.length} requests). Safe to interrupt: rerun to resume.\n`);
  return created.id;
}

/**
 * Waits for the batch to end, then passes each succeeded message to `accept`, which returns whether it
 * was usable (it writes its own reject rows). Errored, canceled and expired requests are rejected here.
 */
export async function collectBatch(
  client: Anthropic,
  command: string,
  batchId: string,
  accept: (customId: string, message: Anthropic.Message) => boolean,
): Promise<void> {
  for (;;) {
    const batch = await client.messages.batches.retrieve(batchId);
    if (batch.processing_status === 'ended') break;
    const c = batch.request_counts;
    process.stdout.write(`Batch ${batchId}: ${batch.processing_status}, ${c.processing} processing, ${c.succeeded} succeeded, ${c.errored} errored\n`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  let usage: Usage = ZERO_USAGE;
  let requests = 0;
  let accepted = 0;
  try {
    for await (const row of await client.messages.batches.results(batchId)) {
      requests++;
      if (row.result.type !== 'succeeded') {
        reject(command, row.custom_id, `batch result ${row.result.type}`, row.result.type === 'errored' ? row.result.error : undefined);
        continue;
      }
      usage = addUsage(usage, fromApiUsage(row.result.message.usage));
      if (accept(row.custom_id, row.result.message)) accepted++;
    }
  } finally {
    const cost = logSpend({ command, batch: true, requests, usage, ref: batchId });
    process.stdout.write(`Collected batch ${batchId}: ${accepted}/${requests} accepted, actual cost ${usd(cost)}.\n`);
  }
  closeRun(command);
}

/** The text of a finished reply, or a reject row and undefined when it stopped early or isn't JSON. */
export function replyJson(command: string, id: string, message: Anthropic.Message): unknown {
  if (message.stop_reason !== 'end_turn') {
    reject(command, id, `stop_reason ${String(message.stop_reason)}`);
    return undefined;
  }
  const text = message.content.find((block) => block.type === 'text')?.text ?? '';
  try {
    return JSON.parse(text) as unknown;
  } catch {
    reject(command, id, 'reply is not JSON', text);
    return undefined;
  }
}
