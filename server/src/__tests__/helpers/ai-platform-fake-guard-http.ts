import http from 'node:http';

export interface FakeGuardCallRecord {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
  aborted: boolean;
}

export interface FakeGuardModerationReply {
  status?: number;
  delayMs?: number;
  body?: unknown;
  rawBody?: string;
}

export interface FakeGuardJudgeReply {
  status?: number;
  delayMs?: number;
  content?: string;
  finishReason?: string;
  rawBody?: string;
}

export interface FakeGuardHttpServer {
  url: string;
  port: number;
  calls: FakeGuardCallRecord[];
  setModerationHandler(fn: (req: FakeGuardCallRecord) => FakeGuardModerationReply | Promise<FakeGuardModerationReply>): void;
  setJudgeHandler(fn: (req: FakeGuardCallRecord) => FakeGuardJudgeReply | Promise<FakeGuardJudgeReply>): void;
  close(): Promise<void>;
}

export async function startFakeGuardHttpServer(): Promise<FakeGuardHttpServer> {
  const calls: FakeGuardCallRecord[] = [];
  let moderationHandler: (req: FakeGuardCallRecord) => FakeGuardModerationReply | Promise<FakeGuardModerationReply> = () => ({
    status: 200,
    body: {
      id: 'modr-fake',
      model: 'omni-moderation-latest',
      results: [{ flagged: false, categories: {}, category_scores: {} }],
    },
  });
  let judgeHandler: (req: FakeGuardCallRecord) => FakeGuardJudgeReply | Promise<FakeGuardJudgeReply> = () => ({
    status: 200,
    content: JSON.stringify({ violation: false, reason: 'ok' }),
    finishReason: 'stop',
  });

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    const record: FakeGuardCallRecord = {
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      headers: req.headers,
      body: null,
      aborted: false,
    };
    calls.push(record);

    req.on('aborted', () => {
      record.aborted = true;
    });
    res.on('close', () => {
      if (!res.writableEnded) {
        record.aborted = true;
      }
    });

    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        record.body = raw ? JSON.parse(raw) : null;
      } catch {
        record.body = raw;
      }

      const path = (req.url ?? '/').split('?')[0];
      try {
        if (path.endsWith('/v1/moderations')) {
          const reply = await moderationHandler(record);
          if (reply.delayMs && reply.delayMs > 0) {
            await new Promise<void>((resolve) => {
              const t = setTimeout(resolve, reply.delayMs);
              res.once('close', () => {
                clearTimeout(t);
                resolve();
              });
            });
          }
          if (res.writableEnded || res.destroyed || record.aborted) return;
          const status = reply.status ?? 200;
          const payload = reply.rawBody ?? JSON.stringify(reply.body ?? {});
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(payload);
          return;
        }

        if (path.endsWith('/v1/chat/completions')) {
          const reply = await judgeHandler(record);
          if (reply.delayMs && reply.delayMs > 0) {
            await new Promise<void>((resolve) => {
              const t = setTimeout(resolve, reply.delayMs);
              res.once('close', () => {
                clearTimeout(t);
                resolve();
              });
            });
          }
          if (res.writableEnded || res.destroyed || record.aborted) return;
          const status = reply.status ?? 200;
          if (reply.rawBody !== undefined) {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(reply.rawBody);
            return;
          }
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'chatcmpl-fake-judge',
              object: 'chat.completion',
              model: 'fake-judge-model',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: reply.content ?? '{"violation":false,"reason":"ok"}' },
                  finish_reason: reply.finishReason ?? 'stop',
                },
              ],
              usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
            }),
          );
          return;
        }

        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'not found' } }));
      } catch {
        if (!res.writableEnded && !res.destroyed) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'fake server error' } }));
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}`,
    port: addr.port,
    calls,
    setModerationHandler(fn) {
      moderationHandler = fn;
    },
    setJudgeHandler(fn) {
      judgeHandler = fn;
    },
    async close() {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}
