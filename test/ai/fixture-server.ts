import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { join } from 'node:path';

export interface FixtureResponse {
  status: number;
  contentType: string;
  body: unknown;
  headers?: Record<string, string>;
}

export interface Fixture {
  synthetic?: boolean;
  request: { method: string; path: string; body: unknown };
  response: FixtureResponse;
}

export interface ReceivedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export function loadFixture(name: string): Fixture {
  return JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'ai', `${name}.json`), 'utf8')) as Fixture;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as unknown) : null;
}

/** A local HTTP server that answers queued responses in order, so real SDKs run fully offline. */
export class FixtureServer {
  readonly received: ReceivedRequest[] = [];
  private readonly queue: FixtureResponse[] = [];
  private server: Server | undefined;

  enqueue(...responses: FixtureResponse[]): this {
    this.queue.push(...responses);
    return this;
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      void readBody(req).then((body) => {
        this.received.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body });
        const next = this.queue.shift() ?? { status: 500, contentType: 'application/json', body: { error: 'no fixture queued' } };
        res.writeHead(next.status, { 'content-type': next.contentType, ...next.headers });
        res.end(JSON.stringify(next.body));
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server?.close(() => {
        resolve();
      });
    });
  }
}
