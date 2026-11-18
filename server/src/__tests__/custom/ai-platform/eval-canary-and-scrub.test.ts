import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Request, type Response } from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../app.js';
import { getDb, initDb } from '../../../db/index.js';
import { clientContextMiddleware, setRequestProfile } from '../../../lib/client-context.js';
import { encrypt } from '../../../lib/crypto.js';
import {
  hashClientProfileKey,
  mintClientProfileKey,
  prependSystemPrompt,
} from '../../../lib/system-prompt.js';
import { resetFlagsCacheForTests, setFlags } from '../../../custom/ai-platform/flags.js';
import { aiPlatformPermission } from '../../../custom/ai-platform/permissions.js';
import { purgeScope } from '../../../custom/ai-platform/scope.js';
import {
  createCredentialStreamScrubber,
  findCredentialPartialTailIndex,
  getCredentialScrubSettings,
  scrubCredentialsInText,
  setCredentialScrubSettings,
} from '../../../custom/ai-platform/output-guard/credential-stream-scrubber.js';
import {
  getGuardExcerpt,
  listGuardEvents,
  resetGuardEventRateLimitForTests,
} from '../../../custom/ai-platform/output-guard/events.js';
import {
  evaluateOutput,
  outputFilterFor,
  setPolicy,
} from '../../../custom/ai-platform/output-guard/policy.js';
import { disposePatternWorkerPool } from '../../../custom/ai-platform/output-guard/pattern-validator.js';
import {
  abortCanary,
  computeStickyBucketPercent,
  getCanaryConfig,
  promoteCanary,
  recordCanaryOutcome,
  selectPromptVariant,
  selectVariantByWeight,
  setCanaryConfig,
} from '../../../custom/ai-platform/prompts/canary.js';
import {
  createEvalCase,
  deleteEvalCase,
  getEvalRun,
  hasUnsafeEvalRegexConstruct,
  listEvalCases,
  listEvalRuns,
  runPromptEvaluation,
  updateEvalCase,
} from '../../../custom/ai-platform/prompts/evals.js';
import { capturePromptRequestContext } from '../../../custom/ai-platform/prompts/render.js';
import {
  getPromptScopeState,
  publish,
  saveDraft,
} from '../../../custom/ai-platform/prompts/store.js';
import { installInterceptor } from '../../../custom/ai-platform/wire/interceptor.js';
import { DEFAULT_GUARD_DETECTORS } from '@freellmapi/shared/ai-platform-output-guard.js';
import { mintDashboardToken } from '../../helpers/auth.js';

function insertTestProfile(name: string, systemPrompt: string | null = null): { id: number; key: string } {
  const key = mintClientProfileKey();
  const { encrypted, iv, authTag } = encrypt(key);
  const res = getDb()
    .prepare(
      `INSERT INTO client_profiles (name, token_hash, encrypted_key, iv, auth_tag, system_prompt, enabled)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
    )
    .run(name, hashClientProfileKey(key), encrypted, iv, authTag, systemPrompt);
  return { id: Number(res.lastInsertRowid), key };
}

function httpJson(
  port: number,
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : '';
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          ...(body !== undefined ? { 'content-length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed: Record<string, unknown> = {};
          try {
            parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
          } catch {
            parsed = { raw };
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, json: parsed });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(payload);
    req.end();
  });
}

function httpRawStream(
  port: number,
  path: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string; chunks: string[] }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...extraHeaders,
        },
      },
      (res) => {
        const chunks: string[] = [];
        res.on('data', (c: Buffer) => chunks.push(c.toString('utf8')));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: chunks.join(''),
            chunks,
          });
        });
      },
    );
    req.on('error', reject);
    req.write('{}');
    req.end();
  });
}

describe('Spec 034: Prompt Eval Harness, Weighted Canary Split & Real-Time SSE Credential Scrubber', () => {
  let dashboardToken = '';
  let adminServer: http.Server | null = null;
  let adminPort = 0;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    initDb(':memory:');
    dashboardToken = mintDashboardToken('eval-scrub-admin@example.com');

    const app = createApp();
    adminServer = await new Promise<http.Server>((resolve) => {
      const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
    });
    adminPort = (adminServer.address() as AddressInfo).port;
  });

  afterEach(() => {
    resetFlagsCacheForTests();
    resetGuardEventRateLimitForTests();
  });

  afterAll(async () => {
    await disposePatternWorkerPool();
    if (adminServer) {
      await new Promise<void>((resolve) => adminServer!.close(() => resolve()));
    }
  });

  // ── 1. Golden Dataset CRUD, Multi-Scope Isolation, ReDoS & 30-Case Cap ────

  it('enforces multi-scope isolation, ReDoS regex rejection, JSON schema validation, and max 30 cases per scope', async () => {
    const p1 = insertTestProfile('eval-scope-a', 'You are helpful.');
    const p2 = insertTestProfile('eval-scope-b', 'You are concise.');
    const scopeA = { kind: 'profile' as const, id: String(p1.id) };
    const scopeB = { kind: 'profile' as const, id: String(p2.id) };

    // Reject catastrophic backtracking regexes (static + isolated worker check)
    expect(hasUnsafeEvalRegexConstruct('(a+)+$')).toBeTruthy();
    expect(hasUnsafeEvalRegexConstruct('(foo)\\1')).toBeTruthy();

    await expect(
      createEvalCase(scopeA, {
        title: 'Unsafe ReDoS regex',
        userMessage: 'Hello',
        assertions: [{ type: 'regex', pattern: '(a+)+$' }],
      }),
    ).rejects.toMatchObject({ code: 'unsafe_pattern', status: 422 });

    // Create valid case in Scope A with all 5 assertion types
    const created = await createEvalCase(scopeA, {
      title: 'Structured refund JSON',
      userMessage: 'Can I get a refund for order #42?',
      variables: { company_name: 'AcmeCorp' },
      assertions: [
        { type: 'contains', value: 'eligible' },
        { type: 'not_contains', value: 'INTERNAL_SECRET' },
        { type: 'regex', pattern: '"orderId"\\s*:\\s*42' },
        {
          type: 'json_schema',
          schema: {
            type: 'object',
            required: ['eligible', 'orderId'],
            properties: {
              eligible: { type: 'boolean' },
              orderId: { type: 'number' },
            },
          },
        },
        { type: 'max_chars', limit: 300 },
      ],
    });

    expect(created.id).toBeGreaterThan(0);
    expect(listEvalCases(scopeA)).toHaveLength(1);
    // Scope B cannot see, update, or delete Scope A's case
    expect(listEvalCases(scopeB)).toHaveLength(0);
    await expect(
      updateEvalCase(scopeB, created.id, {
        title: 'Cross-scope hijack',
        userMessage: 'Hijack',
        assertions: [{ type: 'contains', value: 'ok' }],
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(() => deleteEvalCase(scopeB, created.id)).toThrow();

    // Update in owning scope succeeds
    const updated = await updateEvalCase(scopeA, created.id, {
      title: 'Updated refund JSON check',
      userMessage: 'Refund order #42',
      variables: { company_name: 'AcmeCorp' },
      assertions: created.assertions,
    });
    expect(updated.title).toBe('Updated refund JSON check');

    // Fill up to 30 cases in Scope A; 31st must fail with 422 max_eval_cases_exceeded
    for (let i = 2; i <= 30; i += 1) {
      await createEvalCase(scopeA, {
        title: `Case #${i}`,
        userMessage: `Question ${i}`,
        assertions: [{ type: 'contains', value: 'ok' }],
      });
    }
    expect(listEvalCases(scopeA)).toHaveLength(30);

    await expect(
      createEvalCase(scopeA, {
        title: 'Case #31 overflow',
        userMessage: 'Overflow',
        assertions: [{ type: 'contains', value: 'ok' }],
      }),
    ).rejects.toMatchObject({ code: 'max_eval_cases_exceeded', status: 422 });

    // Scope B is unaffected by Scope A's cap
    const bCase = await createEvalCase(scopeB, {
      title: 'Scope B independent case',
      userMessage: 'Ping',
      assertions: [{ type: 'contains', value: 'pong' }],
    });
    expect(bCase.scopeId).toBe(String(p2.id));
  });

  // ── 2. Comparative Prompt Evaluation (published vs draft) ─────────────────

  it('compares draft vs published versions across golden cases and detects regressions and improvements', async () => {
    setFlags({ prompts: true });
    const prof = insertTestProfile('eval-runner-profile', null);
    const scope = { kind: 'profile' as const, id: String(prof.id) };

    // Create v1 draft and publish it as baseline
    const state0 = getPromptScopeState(scope);
    saveDraft(
      scope,
      {
        body: 'You are {{company_name}} JSON bot. Return valid JSON with status and orderId.',
        variables: [{ name: 'company_name', source: 'custom', default: 'DefaultCo' }],
        note: 'v1 baseline',
        revision: state0.head.revision,
      },
      1,
    );
    const head1 = publish(scope, getPromptScopeState(scope).head.revision, 1);
    expect(head1.publishedVersion).toBe(1);

    // Save v2 draft that regresses on JSON format
    saveDraft(
      scope,
      {
        body: 'You are {{company_name}} casual chat bot. Never use JSON.',
        variables: [{ name: 'company_name', source: 'custom', default: 'DefaultCo' }],
        note: 'v2 regressed draft',
        revision: head1.revision,
      },
      1,
    );

    await createEvalCase(scope, {
      title: 'JSON order status',
      userMessage: 'Check order 99',
      variables: { company_name: 'Globex' },
      assertions: [
        { type: 'contains', value: 'Globex' },
        {
          type: 'json_schema',
          schema: {
            type: 'object',
            required: ['company', 'status'],
            properties: {
              company: { type: 'string' },
              status: { type: 'string' },
            },
          },
        },
        { type: 'max_chars', limit: 120 },
      ],
    });

    await createEvalCase(scope, {
      title: 'Polite greeting without forbidden word',
      userMessage: 'Say hello',
      variables: { company_name: 'Globex' },
      assertions: [
        { type: 'contains', value: 'Globex' },
        { type: 'not_contains', value: 'FORBIDDEN_TOKEN' },
      ],
    });

    const mockGateway: Parameters<typeof runPromptEvaluation>[2]['callGatewayFn'] = async (
      _req,
      loopReq,
    ) => {
      const sys = String(loopReq.messages[0]?.content ?? '');
      const usr = String(loopReq.messages[loopReq.messages.length - 1]?.content ?? '');
      const isJsonBot = sys.includes('JSON bot');
      const reply = usr.includes('order 99')
        ? isJsonBot
          ? '{"company":"Globex","status":"shipped"}'
          : 'Hi from Globex! Your order 99 is shipped in plain text.'
        : 'Welcome to Globex support!';
      return {
        message: { role: 'assistant', content: reply },
        finishReason: 'stop',
        usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 },
        servedModel: 'mock-eval-model',
      };
    };

    const run1 = await runPromptEvaluation(
      scope,
      { model: 'mock-eval-model' },
      { actorId: 1, callGatewayFn: mockGateway },
    );

    expect(run1.baselineVersion).toBe(1);
    expect(run1.candidateVersion).toBe(2);
    expect(run1.baselineSummary?.passRate).toBe(1);
    expect(run1.candidateSummary.passRate).toBe(0.5);
    expect(run1.regressions).toBe(1);
    expect(run1.improvements).toBe(0);
    expect(run1.cases[0]?.regressed).toBe(true);
    expect(run1.cases[1]?.candidate.passed).toBe(true);

    // Verify HTTP admin read endpoints for eval cases & runs
    const casesRes = await httpJson(
      adminPort,
      'GET',
      `/api/ai-platform/prompts/profile/${prof.id}/evals/cases`,
      dashboardToken,
    );
    expect(casesRes.status).toBe(200);
    expect((casesRes.json.cases as unknown[]).length).toBe(2);

    const runsRes = await httpJson(
      adminPort,
      'GET',
      `/api/ai-platform/prompts/profile/${prof.id}/evals/runs`,
      dashboardToken,
    );
    expect(runsRes.status).toBe(200);
    expect(listEvalRuns(scope)).toHaveLength(1);
    expect(getEvalRun(scope, run1.id).regressions).toBe(1);
  });

  // ── 3. Weighted Canary Traffic Split, Sticky Sessions, Header & Rollback ──

  it('routes weighted canary traffic, preserves sticky X-Conversation-Id / endUser sessions, emits X-FreeLLM-Prompt-Variant, and supports promote & instant rollback', async () => {
    setFlags({ prompts: true });
    const prof = insertTestProfile('canary-profile', null);
    const scope = { kind: 'profile' as const, id: String(prof.id) };

    // Publish v1 ("PUBLISHED_V1") and create draft v2 ("CANARY_V2 {{company}}")
    const s0 = getPromptScopeState(scope);
    saveDraft(
      scope,
      {
        body: 'PUBLISHED_V1 plain system prompt',
        variables: [],
        note: 'v1',
        revision: s0.head.revision,
      },
      1,
    );
    const h1 = publish(scope, getPromptScopeState(scope).head.revision, 1);

    const v2 = saveDraft(
      scope,
      {
        body: 'CANARY_V2 for {{company}}',
        variables: [{ name: 'company', source: 'caller', default: 'FallbackOrg' }],
        note: 'v2 canary candidate',
        revision: h1.revision,
      },
      1,
    );
    expect(v2.version).toBe(2);

    // Configure 40% canary via HTTP PUT
    const putRes = await httpJson(
      adminPort,
      'PUT',
      `/api/ai-platform/prompts/profile/${prof.id}/canary`,
      dashboardToken,
      {
        enabled: true,
        candidateVersion: 2,
        trafficPercent: 40,
      },
    );
    expect(putRes.status).toBe(200);
    expect((putRes.json.canary as { enabled: boolean; trafficPercent: number }).enabled).toBe(true);

    // Weighted selector respects exact probability thresholds
    expect(
      selectVariantByWeight(
        [
          { variant: 'canary', weight: 40 },
          { variant: 'published', weight: 60 },
        ],
        () => 0.15,
      ).variant,
    ).toBe('canary');
    expect(
      selectVariantByWeight(
        [
          { variant: 'canary', weight: 40 },
          { variant: 'published', weight: 60 },
        ],
        () => 0.85,
      ).variant,
    ).toBe('published');

    // Find one sticky conversation ID that hashes into canary (<40) and one into published (>=40)
    let canaryConvId = '';
    let publishedConvId = '';
    for (let i = 1; i <= 200; i += 1) {
      const cid = `conv_session_${i}`;
      const bucket = computeStickyBucketPercent(scope, 2, `conv:${cid}`);
      if (!canaryConvId && bucket < 40) canaryConvId = cid;
      if (!publishedConvId && bucket >= 40) publishedConvId = cid;
      if (canaryConvId && publishedConvId) break;
    }
    expect(canaryConvId).toBeTruthy();
    expect(publishedConvId).toBeTruthy();

    // Multi-turn stickiness: 15 consecutive turns with the same conversationId never flip variants!
    for (let turn = 0; turn < 15; turn += 1) {
      const selCanary = selectPromptVariant(scope, { conversationId: canaryConvId });
      expect(selCanary.variant).toBe('canary');
      expect(selCanary.headerValue).toBe('canary(v2)');

      const selPub = selectPromptVariant(scope, { conversationId: publishedConvId });
      expect(selPub.variant).toBe('published');
      expect(selPub.headerValue).toBe('published');
    }

    // Spin up a lightweight Express pipeline harness to test real HTTP header + prompt rendering + telemetry
    const harnessApp = express();
    harnessApp.use(express.json());
    harnessApp.use(clientContextMiddleware);
    harnessApp.post('/v1/chat/completions', (req: Request, res: Response) => {
      setRequestProfile(prof.id);
      capturePromptRequestContext(
        req,
        { id: prof.id, name: 'canary-profile' } as Parameters<typeof capturePromptRequestContext>[1],
        (req.headers['x-end-user'] as string | undefined) ?? null,
        res,
      );
      const storedPrompt = (
        getDb()
          .prepare('SELECT system_prompt FROM client_profiles WHERE id = ?')
          .get(prof.id) as { system_prompt: string | null }
      ).system_prompt;
      const msgs = prependSystemPrompt([{ role: 'user', content: 'hi' }], storedPrompt);
      if (req.headers['x-simulate-500'] === '1') {
        res.status(500).json({ error: 'simulated upstream failure' });
        return;
      }
      res.status(200).json({ system: msgs[0]?.content });
    });

    const harnessSrv = await new Promise<http.Server>((resolve) => {
      const s = harnessApp.listen(0, '127.0.0.1', () => resolve(s));
    });
    const harnessPort = (harnessSrv.address() as AddressInfo).port;

    try {
      // Request 1: sticky canary conversation -> renders CANARY_V2 with caller var + sets canary(v2) header
      const r1 = await httpRawStream(harnessPort, '/v1/chat/completions', {
        'x-conversation-id': canaryConvId,
        'x-freellm-vars': JSON.stringify({ company: 'Initech' }),
      });
      expect(r1.status).toBe(200);
      expect(r1.headers['x-freellm-prompt-variant']).toBe('canary(v2)');
      expect(JSON.parse(r1.text)).toEqual({ system: 'CANARY_V2 for Initech' });

      // Request 2: sticky canary conversation with 500 error -> increments canaryErrors
      const r2 = await httpRawStream(harnessPort, '/v1/chat/completions', {
        'x-conversation-id': canaryConvId,
        'x-simulate-500': '1',
      });
      expect(r2.status).toBe(500);
      expect(r2.headers['x-freellm-prompt-variant']).toBe('canary(v2)');

      // Request 3: sticky published conversation -> serves PUBLISHED_V1 + sets published header
      const r3 = await httpRawStream(harnessPort, '/v1/chat/completions', {
        'x-conversation-id': publishedConvId,
      });
      expect(r3.status).toBe(200);
      expect(r3.headers['x-freellm-prompt-variant']).toBe('published');
      expect(JSON.parse(r3.text)).toEqual({ system: 'PUBLISHED_V1 plain system prompt' });

      const metrics = getCanaryConfig(scope);
      expect(metrics.canaryImpressions).toBe(2);
      expect(metrics.canaryErrors).toBe(1);
      expect(metrics.publishedImpressions).toBe(1);
      expect(metrics.publishedErrors).toBe(0);

      // Instant rollback / abort -> 100% traffic immediately reverts to published while preserving telemetry
      const abortRes = await httpJson(
        adminPort,
        'POST',
        `/api/ai-platform/prompts/profile/${prof.id}/canary/abort`,
        dashboardToken,
      );
      expect(abortRes.status).toBe(200);
      expect((abortRes.json.canary as { enabled: boolean; canaryImpressions: number }).enabled).toBe(
        false,
      );
      expect(
        (abortRes.json.canary as { enabled: boolean; canaryImpressions: number }).canaryImpressions,
      ).toBe(2);

      const rAfterAbort = await httpRawStream(harnessPort, '/v1/chat/completions', {
        'x-conversation-id': canaryConvId,
      });
      expect(rAfterAbort.headers['x-freellm-prompt-variant']).toBe('published');
      expect(JSON.parse(rAfterAbort.text)).toEqual({ system: 'PUBLISHED_V1 plain system prompt' });

      // Re-enable canary and test one-click Promote -> v2 becomes published!
      setCanaryConfig(scope, { enabled: true, candidateVersion: 2, trafficPercent: 25 }, 1);
      recordCanaryOutcome(scope, 'canary', { latencyMs: 42, error: false });

      const promoteRes = await httpJson(
        adminPort,
        'POST',
        `/api/ai-platform/prompts/profile/${prof.id}/canary/promote`,
        dashboardToken,
        { revision: getPromptScopeState(scope).head.revision },
      );
      expect(promoteRes.status).toBe(200);
      expect(promoteRes.json.publishedVersion).toBe(2);
      expect(getPromptScopeState(scope).head.publishedVersion).toBe(2);
      expect(abortCanary(scope, 1).canary.enabled).toBe(false);
      expect(() => promoteCanary(scope, undefined, 1)).toThrow();
    } finally {
      await new Promise<void>((resolve) => harnessSrv.close(() => resolve()));
    }
  });

  // ── 4. Zero-Leak Multi-Chunk SSE & Non-Streaming Credential Scrubber ──────

  it('holds back partial credential prefixes across SSE chunk boundaries and never leaks raw secrets to clients or guard event logs', async () => {
    setFlags({ outputGuard: true });
    const prof = insertTestProfile('scrub-profile', 'Keep responses helpful.');
    const scope = { kind: 'profile' as const, id: String(prof.id) };

    // Enable Credential Stream Scrubber via HTTP admin route
    const putScrub = await httpJson(
      adminPort,
      'PUT',
      `/api/ai-platform/output-guard/profile/${prof.id}/credential-scrub`,
      dashboardToken,
      { credentialStreamScrubEnabled: true },
    );
    expect(putScrub.status).toBe(200);
    expect(getCredentialScrubSettings(scope).credentialStreamScrubEnabled).toBe(true);

    // 4a. Unit verification of tail boundary detector
    expect(findCredentialPartialTailIndex('Hello world ')).toBeUndefined();
    expect(findCredentialPartialTailIndex('Token: sk-proj-abc')).toBe(7);
    expect(findCredentialPartialTailIndex('Header: -----BEG')).toBe(8);
    expect(findCredentialPartialTailIndex('DB: postgres://admin:sec')).toBe(4);

    // 4b. 1-character-at-a-time torture test across ALL credential families + inline image URL preservation
    // Assemble synthetic fixtures dynamically so static secret scanners never flag test source.
    const rawOpenAiKey = ['sk', 'proj', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4'].join('-');
    const rawAnthropicKey = ['sk', 'ant', 'api03', 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6'].join('-');
    const rawGoogleKey = ['AIza', 'SyDaGmWKa4JsXZ-0123456789abcdef'].join('');
    const rawGithubKey = ['ghp', '1234567890abcdefghijklmnopqrstuvwxyz'].join('_');
    const rawAwsKey = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
    const rawSlackKey = ['xoxb', '123456789012', '987654321098', 'AbCdEfGhIjKlMn'].join('-');
    const rawNpmKey = ['npm', '1234567890abcdefghijklmnopqrstuvwxyz'].join('_');
    const rawPem = [
      ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' '),
      'MIIEpAIBAAKCAQEA0123456789abcdefSECRETKEYBODY',
      ['-----END', 'RSA PRIVATE KEY-----'].join(' '),
    ].join('\n');
    const rawPgUri = ['postgres://dbadmin', 'UltraS3cr3tPass!@db.internal:5432/prod'].join(':');
    const rawMongoUri = ['mongodb+srv://root', 'MongoS3cr3t99@cluster0.example.net/app'].join(':');
    const rawRedisUri = ['redis://', 'RedisP4ssw0rd@cache.internal:6379/0'].join(':');
    const inlineImage = [
      'data:image/png;base64,',
      'AIza',
      'SyDaGmWKa4JsXZ0123456789',
      'AKIA',
      'IOSFODNN7EXAMPLE==',
    ].join('');

    const fullPayload = [
      `OpenAI=${rawOpenAiKey}`,
      `Claude="${rawAnthropicKey}"`,
      `Google=${rawGoogleKey}`,
      `GitHub=${rawGithubKey}`,
      `AWS=${rawAwsKey}`,
      `Slack=${rawSlackKey}`,
      `NPM=${rawNpmKey}`,
      `PEM:\n${rawPem}`,
      `PG=${rawPgUri}`,
      `MONGO=${rawMongoUri}`,
      `REDIS=${rawRedisUri}`,
      `IMG=${inlineImage}`,
      'Done.',
    ].join(' | ');

    const charScrubber = createCredentialStreamScrubber();
    let streamedOutput = '';
    const sensitiveFragments = [
      'A1b2C3d4E5f6',
      'Z9y8X7w6V5u4',
      '1234567890abcdefghijklmnopqrstuvwxyz',
      '987654321098',
      'SECRETKEYBODY',
      'UltraS3cr3tPass',
      'MongoS3cr3t99',
      'RedisP4ssw0rd',
    ];

    for (const ch of fullPayload) {
      const step = charScrubber.push(ch);
      streamedOutput += step.emit;
      // At EVERY intermediate emission step, zero secret fragments may ever appear!
      for (const secretSub of sensitiveFragments) {
        expect(streamedOutput).not.toContain(secretSub);
      }
      expect(streamedOutput).not.toContain(`Google=${rawGoogleKey}`);
      expect(streamedOutput).not.toContain(`AWS=${rawAwsKey}`);
    }
    streamedOutput += charScrubber.flush().emit;

    for (const secretSub of sensitiveFragments) {
      expect(streamedOutput).not.toContain(secretSub);
    }
    expect(streamedOutput).not.toContain(`Google=${rawGoogleKey}`);
    expect(streamedOutput).not.toContain(`AWS=${rawAwsKey}`);
    expect(streamedOutput).toContain('[REDACTED:openai]');
    expect(streamedOutput).toContain('[REDACTED:anthropic]');
    expect(streamedOutput).toContain('[REDACTED:google]');
    expect(streamedOutput).toContain('[REDACTED:github]');
    expect(streamedOutput).toContain('[REDACTED:aws]');
    expect(streamedOutput).toContain('[REDACTED:slack]');
    expect(streamedOutput).toContain('[REDACTED:npm]');
    expect(streamedOutput).toContain('[REDACTED:private_key]');
    expect(streamedOutput).toContain('postgres://[REDACTED:credentials]@db.internal:5432/prod');
    expect(streamedOutput).toContain('mongodb+srv://[REDACTED:credentials]@cluster0.example.net/app');
    expect(streamedOutput).toContain('redis://[REDACTED:credentials]@cache.internal:6379/0');
    // Image data URL must remain uncorrupted
    expect(streamedOutput).toContain(inlineImage);

    // Unclosed truncated PEM at EOF must also be redacted in full
    const unclosedRes = scrubCredentialsInText(
      `Prefix ${['-----BEGIN', 'OPENSSH PRIVATE KEY-----'].join(' ')}\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU=`,
    );
    expect(unclosedRes.text).toBe('Prefix [REDACTED:private_key]');

    // 4c. End-to-end SSE Interceptor + Output Guard policy (mode: 'block' with PII masking)
    // Verify multi-chunk SSE scrubbing AND zero raw secret leakage in custom_ai_guard_events!
    await setPolicy(
      scope,
      {
        mode: 'block',
        detectors: {
          ...structuredClone(DEFAULT_GUARD_DETECTORS),
          pii: { enabled: true, action: 'mask' },
        },
        replacementText: 'Blocked by policy.',
        failMode: 'allow',
        bypassRoles: [],
        holdChars: 40,
        maxDelayMs: 300,
        revision: 0,
      },
      1,
    );

    const sseApp = express();
    sseApp.post('/stream', (req: Request, res: Response) => {
      const filter = outputFilterFor(scope, {
        req,
        endUser: 'user-sse-1',
        wire: 'openai-chat',
        stream: true,
        systemPrompt: null,
      });
      if (filter) {
        installInterceptor(req, res, 'openai-chat', [filter]);
      }
      res.setHeader('Content-Type', 'text/event-stream');

      const sseChunks = [
        'Here is OpenAI key sk-',
        'proj-SuperSecretKeyValue9876543210 ',
        'and DB mongodb://admin:',
        'TopSecretMongoPass@db.local:27017/app ',
        'and PEM -----BE',
        'GIN PRIVATE KEY-----\nMIIBVwIBADANBgkqhkiG9w0BAQEFAASCAT8=\n-----END ',
        'PRIVATE KEY----- end!',
      ];

      for (const delta of sseChunks) {
        const frame = `data: ${JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion.chunk',
          model: 'gpt-test',
          choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
        })}\n\n`;
        res.write(frame);
      }
      res.write(
        `data: ${JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion.chunk',
          model: 'gpt-test',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
    });

    sseApp.post('/json', (req: Request, res: Response) => {
      const filter = outputFilterFor(scope, {
        req,
        endUser: 'user-json-1',
        wire: 'openai-chat',
        stream: false,
        systemPrompt: null,
      });
      if (filter) {
        installInterceptor(req, res, 'openai-chat', [filter]);
      }
      res.json({
        id: 'chatcmpl-json',
        object: 'chat.completion',
        model: 'gpt-test',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: `Non-stream secret ${['ghp', 'SecretGitHubToken1234567890abcdef'].join('_')} and ${['redis://', 'SecretRedis99@127.0.0.1:6379'].join(':')}`,
            },
            finish_reason: 'stop',
          },
        ],
      });
    });

    const sseSrv = await new Promise<http.Server>((resolve) => {
      const s = sseApp.listen(0, '127.0.0.1', () => resolve(s));
    });
    const ssePort = (sseSrv.address() as AddressInfo).port;

    try {
      const streamRes = await httpRawStream(ssePort, '/stream');
      expect(streamRes.status).toBe(200);
      expect(streamRes.text).not.toContain('SuperSecretKeyValue9876543210');
      expect(streamRes.text).not.toContain('TopSecretMongoPass');
      expect(streamRes.text).not.toContain('MIIBVwIBADANBgkqhkiG9w0BAQEFAASCAT8');

      const reconstructedSseText = streamRes.text
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .filter((payload) => payload && payload !== '[DONE]')
        .map((payload) => {
          const parsed = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          return parsed.choices?.[0]?.delta?.content ?? '';
        })
        .join('');

      expect(reconstructedSseText).toContain('[REDACTED:openai]');
      expect(reconstructedSseText).toContain('mongodb://[REDACTED:credentials]@db.local:27017/app');
      expect(reconstructedSseText).toContain('[REDACTED:private_key]');

      const jsonRes = await httpRawStream(ssePort, '/json');
      expect(jsonRes.status).toBe(200);
      expect(jsonRes.text).not.toContain('SecretGitHubToken1234567890abcdef');
      expect(jsonRes.text).not.toContain('SecretRedis99');
      expect(jsonRes.text).toContain('[REDACTED:github]');
      expect(jsonRes.text).toContain('redis://[REDACTED:credentials]@127.0.0.1:6379');

      // Direct non-interceptor path (`evaluateOutput`) also scrubs without leaking
      const directEval = await evaluateOutput(
        scope,
        `Direct path key ${rawAwsKey}`,
        {
          endUser: 'user-direct',
          wire: 'support',
          stream: false,
          systemPrompt: null,
        },
      );
      expect(directEval.action).toBe('masked');
      expect(directEval.text).toBe('Direct path key [REDACTED:aws]');

      // Verify ZERO raw secrets exist in custom_ai_guard_events or decrypted excerpts!
      const events = listGuardEvents({ scope: `profile/${prof.id}` });
      expect(events.events.length).toBeGreaterThan(0);

      for (const ev of events.events) {
        if (ev.hasExcerpt) {
          const { excerpt } = getGuardExcerpt(ev.id);
          expect(excerpt).not.toContain('SuperSecretKeyValue9876543210');
          expect(excerpt).not.toContain('TopSecretMongoPass');
          expect(excerpt).not.toContain('MIIBVwIBADANBgkqhkiG9w0BAQEFAASCAT8');
          expect(excerpt).not.toContain('SecretGitHubToken1234567890abcdef');
          expect(excerpt).not.toContain('SecretRedis99');
          expect(excerpt).not.toContain('AKIAIOSFODNN7EXAMPLE');
        }
      }

      // Cleanup trigger check: deleting client_profile purges scrub settings, canary & eval rows
      setCredentialScrubSettings(scope, { credentialStreamScrubEnabled: true }, 1);
      getDb().prepare('DELETE FROM client_profiles WHERE id = ?').run(prof.id);
      const orphanCount = (
        getDb()
          .prepare(
            "SELECT COUNT(*) AS cnt FROM custom_ai_credential_scrub_settings WHERE scope_kind = 'profile' AND scope_id = ?",
          )
          .get(String(prof.id)) as { cnt: number }
      ).cnt;
      expect(orphanCount).toBe(0);
    } finally {
      await new Promise<void>((resolve) => sseSrv.close(() => resolve()));
    }
  });

  it('maps Spec 034 routes to leaf RBAC permissions, purges scope tables, and preserves image passThrough on PEM overflow', async () => {
    // 1. Leaf RBAC mappings in aiPlatformPermission()
    expect(aiPlatformPermission('GET', '/api/ai-platform/prompts/profile/1/evals/cases')).toBe(
      'view_prompts',
    );
    expect(aiPlatformPermission('POST', '/api/ai-platform/prompts/profile/1/evals/cases')).toBe(
      'edit_prompts',
    );
    expect(aiPlatformPermission('PUT', '/api/ai-platform/prompts/profile/1/evals/cases/7')).toBe(
      'edit_prompts',
    );
    expect(
      aiPlatformPermission('DELETE', '/api/ai-platform/prompts/profile/1/evals/cases/7'),
    ).toBe('edit_prompts');
    expect(aiPlatformPermission('GET', '/api/ai-platform/prompts/profile/1/evals/runs')).toBe(
      'view_prompts',
    );
    expect(aiPlatformPermission('GET', '/api/ai-platform/prompts/profile/1/evals/runs/12')).toBe(
      'view_prompts',
    );
    expect(aiPlatformPermission('POST', '/api/ai-platform/prompts/profile/1/evals/run')).toBe(
      'edit_prompts',
    );
    expect(aiPlatformPermission('GET', '/api/ai-platform/prompts/profile/1/canary')).toBe(
      'view_prompts',
    );
    expect(aiPlatformPermission('PUT', '/api/ai-platform/prompts/profile/1/canary')).toBe(
      'publish_prompts',
    );
    expect(aiPlatformPermission('POST', '/api/ai-platform/prompts/profile/1/canary/promote')).toBe(
      'publish_prompts',
    );
    expect(aiPlatformPermission('POST', '/api/ai-platform/prompts/profile/1/canary/abort')).toBe(
      'publish_prompts',
    );
    expect(
      aiPlatformPermission('GET', '/api/ai-platform/output-guard/profile/1/credential-scrub'),
    ).toBe('view_output_guard');
    expect(
      aiPlatformPermission('PUT', '/api/ai-platform/output-guard/profile/1/credential-scrub'),
    ).toBe('edit_output_guard');

    // 2. purgeScope() cleans up all 4 Spec 034 tables for target scope only
    const profA = insertTestProfile('purge-scope-a', '');
    const profB = insertTestProfile('purge-scope-b', '');
    const scopeA = { kind: 'profile' as const, id: String(profA.id) };
    const scopeB = { kind: 'profile' as const, id: String(profB.id) };

    saveDraft(scopeA, { body: 'Published A', revision: getPromptScopeState(scopeA).head.revision }, 1);
    const pubHeadA = publish(scopeA, getPromptScopeState(scopeA).head.revision, 1);
    saveDraft(scopeA, { body: 'Candidate A', revision: pubHeadA.revision }, 1);
    await createEvalCase(scopeA, {
      title: 'Purge check A',
      userMessage: 'Hello A',
      assertions: [{ type: 'contains', value: 'A' }],
    });
    setCanaryConfig(scopeA, { enabled: true, candidateVersion: 2, trafficPercent: 25 }, 1);
    setCredentialScrubSettings(scopeA, { credentialStreamScrubEnabled: true }, 1);
    getDb()
      .prepare(
        `INSERT INTO custom_ai_prompt_golden_runs
          (scope_kind, scope_id, model, baseline_version, candidate_version, candidate_label, candidate_summary_json, cases_json)
         VALUES (?, ?, 'gpt-4o-mini', 1, 2, 'draft', '{"totalCases":1,"passedCases":1,"failedCases":0,"passRate":100,"avgLatencyMs":10,"totalPromptTokens":5,"totalCompletionTokens":5,"totalTokens":10}', '[]')`,
      )
      .run(scopeA.kind, scopeA.id);

    await createEvalCase(scopeB, {
      title: 'Keep check B',
      userMessage: 'Hello B',
      assertions: [{ type: 'contains', value: 'B' }],
    });
    setCredentialScrubSettings(scopeB, { credentialStreamScrubEnabled: true }, 1);

    const purged = purgeScope(scopeA.kind, scopeA.id);
    expect(purged).toBeGreaterThanOrEqual(4);
    expect(listEvalCases(scopeA)).toHaveLength(0);
    expect(listEvalRuns(scopeA)).toHaveLength(0);
    expect(getCanaryConfig(scopeA).enabled).toBe(false);
    expect(getCredentialScrubSettings(scopeA).credentialStreamScrubEnabled).toBe(false);

    // Scope B remains intact
    expect(listEvalCases(scopeB)).toHaveLength(1);
    expect(getCredentialScrubSettings(scopeB).credentialStreamScrubEnabled).toBe(true);
    purgeScope(scopeB.kind, scopeB.id);

    // 3. Overflow image continuation followed immediately by overflow PEM preserves cont.passThrough
    const scrubber = createCredentialStreamScrubber({ maxBufferChars: 256, windowChars: 32 });
    const imgPrefix = `data:image/png;base64,${'A'.repeat(300)}`;
    const imgTail = 'BBBB==';
    const pemOverflow = ` middle text ${['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ')}\n${'M'.repeat(320)}`;
    const pemEnd = `\n${['-----END', 'RSA PRIVATE KEY-----'].join(' ')} after`;

    const out1 = scrubber.push(imgPrefix);
    const out2 = scrubber.push(`${imgTail}${pemOverflow}`);
    const out3 = scrubber.push(pemEnd);
    const out4 = scrubber.flush();

    const combined = `${out1.emit}${out2.emit}${out3.emit}${out4.emit}`;
    expect(combined).toBe(
      `${imgPrefix}${imgTail} middle text [REDACTED:private_key] after`,
    );
  });
});
