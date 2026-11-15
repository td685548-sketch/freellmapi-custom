import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectDb, defaultDbFactory, type Db } from '../../db/index.js';
import { runMigrations } from '../../db/migrate/runner.js';
import { nodeSqliteFactory } from '../../db/node-sqlite.js';
import { encrypt, initEncryptionKey } from '../../lib/crypto.js';
import * as routes from '../../custom/x-gateway/router.js';
import * as providers from '../../custom/provider-accounts/execution.js';
import type { BaseProvider } from '../../providers/base.js';

vi.mock('../../custom/x-gateway/quota/tracking.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../custom/x-gateway/quota/tracking.js')>()),
  withQuotaTracking: async (_account: unknown, _model: unknown, _proxy: unknown, call: () => Promise<unknown>) =>
    call(),
}));

import {
  createSupportTenant,
  ensureSupportTables,
  type SupportTenant,
} from '../../custom/x-gateway/support-store.js';
import { ensureSupportServiceDeskTables } from '../../custom/x-gateway/support-service-desk-store.js';
import {
  createSupportEvidenceSource,
  importSupportEvidenceRevision,
  publishSupportEvidenceRevision,
} from '../../custom/x-gateway/support-evidence-store.js';
import {
  createOrAppendSupportConversation,
  getSupportConversationForUser,
} from '../../custom/x-gateway/support-workflows.js';
import {
  generateSupportAgentCopilot,
  readSupportAgentCopilotJob,
} from '../../custom/x-gateway/support-agent-copilot.js';
import {
  listSupportOutputEvents,
  saveSupportOutputPolicy,
} from '../../custom/x-gateway/support-output-store.js';
import { SUPPORT_OUTPUT_BLOCK_NOTICE } from '@freellmapi/shared/support-output.js';

describe('Support Output Copilot Integration (Spec 020)', () => {
  let db: Db;
  let tenant: SupportTenant;
  const actorId = 42;
  const completion = vi.fn();
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.stubEnv('ENCRYPTION_KEY', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');

    db = connectDb(':memory:', {
      factory: (dbPath) => {
        try {
          return defaultDbFactory()(dbPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ERR_DLOPEN_FAILED') throw error;
          return nodeSqliteFactory(dbPath);
        }
      },
    });

    await runMigrations(db, 'up');
    initEncryptionKey(db);
    ensureSupportTables();
    ensureSupportServiceDeskTables(db);

    tenant = createSupportTenant({
      name: 'Copilot Output Org',
      slug: 'copilot-output-org',
      defaultModel: 'test-model',
    }).tenant;

    const secret = encrypt('test-only-provider-key');
    vi.spyOn(routes, 'resolveCandidateRoutes').mockReturnValue({
      candidates: [
        {
          account: {
            id: 1,
            provider: 'test',
            platform: 'test',
            encrypted_key: secret.encrypted,
            iv: secret.iv,
            auth_tag: secret.authTag,
          },
          modelId: 'test-model',
        },
      ],
    } as ReturnType<typeof routes.resolveCandidateRoutes>);

    vi.spyOn(providers, 'resolveAccountProvider').mockReturnValue({
      chatCompletion: completion,
    } as unknown as BaseProvider);

    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    completion.mockReset();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  async function setupConversationAndSource(extra = '') {
    const source = createSupportEvidenceSource(tenant.id, {
      name: 'Shipping Policy',
      kind: 'text',
      allowedRoles: ['customer'],
    });
    const rev = await importSupportEvidenceRevision({
      tenantId: tenant.id,
      sourceId: source.id,
      expectedVersion: source.version,
      title: 'Shipping Policy ' + extra,
      format: 'text',
      content: 'Orders ship within 2 business days with tracking provided. ' + extra,
    });
    publishSupportEvidenceRevision(tenant.id, source.id, rev.revision.id, rev.source.version);

    const conv = createOrAppendSupportConversation(String(tenant.id), {
      userId: 'cust-copilot-1',
      userRole: 'customer',
      subject: 'Shipping question',
      message: {
        senderType: 'customer',
        senderId: 'cust-copilot-1',
        senderRole: 'customer',
        content: 'When will my shipping order arrive?',
      },
    });

    return { source, conv };
  }

  it('discards whole Copilot artifact set with 422 output_blocked when one draft violates policy, settles cost, and sends no customer reply', async () => {
    const sentinel = 'COPILOT_BLOCKED_DRAFT_SECRET';
    const { conv } = await setupConversationAndSource();

    saveSupportOutputPolicy({
      tenantId: tenant.id,
      expectedVersion: 0,
      policy: {
        mode: 'enforce',
        blockedTerms: [{ id: 'copilot-block', text: sentinel }],
        maxOutputChars: 16000,
        redactCredentials: false,
      },
    });

    completion.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              summary: 'Customer asked about shipping [1].',
              drafts: [
                { tone: 'empathetic', text: 'We understand your concern [1].' },
                { tone: 'direct', text: `Orders ship in 2 days [1]. ${sentinel}` },
                { tone: 'technical', text: 'Tracking is issued on dispatch [1].' },
              ],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 40, completion_tokens: 30, total_tokens: 70 },
    });

    let err: unknown;
    try {
      await generateSupportAgentCopilot({
        tenantId: tenant.id,
        actorId,
        input: { requestId: 'cop-block-1', conversationId: conv.id },
      });
    } catch (caught) {
      err = caught;
    }

    expect(err).toMatchObject({
      status: 422,
      code: 'output_blocked',
      message: SUPPORT_OUTPUT_BLOCK_NOTICE,
    });

    // No customer message sent
    const afterConv = getSupportConversationForUser(String(tenant.id), conv.id, {
      userId: 'cust-copilot-1',
      role: 'customer',
    });
    expect(afterConv.messages).toHaveLength(1);

    // Job is fenced as failed and stores no raw artifacts
    const jobRow = db
      .prepare('SELECT state, spent_tokens, payload_encrypted FROM x_support_desk_copilot_jobs WHERE tenant_id = ?')
      .get(tenant.id) as { state: string; spent_tokens: number; payload_encrypted: string };
    expect(jobRow.state).toBe('failed');
    expect(jobRow.spent_tokens).toBe(70);
    expect(jobRow.payload_encrypted).not.toContain(sentinel);

    // Audit event recorded without raw sentinel
    const events = listSupportOutputEvents({ tenantId: tenant.id, limit: 50 }).items;
    expect(events).toHaveLength(1);
    expect(events[0].surface).toBe('copilot');
    expect(events[0].action).toBe('block');
    expect(events[0].ruleIds).toEqual(['copilot-block']);

    const capturedLogs = [...logSpy.mock.calls.flat(), ...warnSpy.mock.calls.flat(), ...errorSpy.mock.calls.flat()]
      .map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
      .join('\n');
    expect(capturedLogs).not.toContain(sentinel);
  });

  it('returns 409 output_policy_changed on Copilot replay and job GET when output policy changes without regenerating', async () => {
    const { conv } = await setupConversationAndSource();

    completion.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              summary: 'Customer asked about shipping [1].',
              drafts: [
                { tone: 'empathetic', text: 'Happy to help with shipping [1].' },
                { tone: 'direct', text: 'Ships in 2 business days [1].' },
                { tone: 'technical', text: 'Dispatch SLA is 2 days [1].' },
              ],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 },
    });

    const created = await generateSupportAgentCopilot({
      tenantId: tenant.id,
      actorId,
      input: { requestId: 'cop-replay-1', conversationId: conv.id },
    });
    expect(created.status).toBe('completed');
    expect(created.output).toEqual({
      policyVersion: 0,
      action: 'allow',
      reasons: [],
      redactionCount: 0,
    });
    expect(completion).toHaveBeenCalledTimes(1);

    // Update output policy -> both replay and read must 409 output_policy_changed
    saveSupportOutputPolicy({
      tenantId: tenant.id,
      expectedVersion: 0,
      policy: {
        mode: 'enforce',
        blockedTerms: [{ id: 'new-rule', text: 'FORBIDDEN' }],
        maxOutputChars: 16000,
        redactCredentials: false,
      },
    });

    await expect(
      generateSupportAgentCopilot({
        tenantId: tenant.id,
        actorId,
        input: { requestId: 'cop-replay-1', conversationId: conv.id },
      }),
    ).rejects.toMatchObject({ status: 409, code: 'output_policy_changed' });

    expect(() =>
      readSupportAgentCopilotJob({
        tenantId: tenant.id,
        actorId,
        jobId: created.jobId,
      }),
    ).toThrowError(expect.objectContaining({ status: 409, code: 'output_policy_changed' }));

    expect(completion).toHaveBeenCalledTimes(1);
  });
  it('audit rolls back when Copilot final persistence fails', async()=>{
    const {conv}=await setupConversationAndSource();
    saveSupportOutputPolicy({tenantId:tenant.id,expectedVersion:0,policy:{mode:'log',blockedTerms:[{id:'shipping',text:'shipping'}],maxOutputChars:16000,redactCredentials:false}});
    completion.mockResolvedValue({choices:[{message:{content:JSON.stringify({summary:'Customer asked about shipping [1].',drafts:[{tone:'empathetic',text:'Happy to help with shipping [1].'},{tone:'direct',text:'Ships in 2 days [1].'},{tone:'technical',text:'Dispatch in 2 days [1].'}]})}}],usage:{prompt_tokens:30,completion_tokens:20,total_tokens:50}});
    db.exec("CREATE TRIGGER review_fail_completion BEFORE UPDATE ON x_support_desk_copilot_jobs WHEN NEW.state = 'completed' BEGIN SELECT RAISE(ABORT, 'review rejected final commit'); END");
    await expect(generateSupportAgentCopilot({tenantId:tenant.id,actorId,input:{requestId:'review-final-fail',conversationId:conv.id}})).rejects.toThrow();
    expect(listSupportOutputEvents({tenantId:tenant.id,limit:50}).items).toEqual([]);
  });

  it('retains valid citations for redacted summary and every draft without restoring source tokens', async () => {
    const token = 'sup_ctx_1234567890abcdef';
    const { conv } = await setupConversationAndSource(token);
    saveSupportOutputPolicy({
      tenantId: tenant.id, expectedVersion: 0,
      policy: { mode: 'enforce', blockedTerms: [], maxOutputChars: 16000, redactCredentials: true },
    });
    completion.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({
        summary: 'Shipping question ' + token + ' [1].',
        drafts: ['empathetic', 'direct', 'technical'].map(tone => ({
          tone, text: 'Orders ship within 2 business days ' + token + ' [1].',
        })),
      }) } }],
      usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 },
    });
    const result = await generateSupportAgentCopilot({
      tenantId: tenant.id, actorId,
      input: { requestId: 'cop-redact-citations', conversationId: conv.id },
    });
    expect(result.status).toBe('completed');
    expect(result.output?.action).toBe('redact');
    expect(result.summaryCitations).toHaveLength(1);
    for (const draft of result.drafts) {
      expect(draft.citations).toHaveLength(1);
      expect(draft.text).toContain('[1]');
      expect(draft.text).toContain('[REDACTED_TOKEN]');
    }
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(readSupportAgentCopilotJob({ tenantId: tenant.id, actorId, jobId: result.jobId }))).not.toContain(token);
  });

  it('commits the failed fenced job on corrupt output policy without an audit event', async () => {
    const { conv } = await setupConversationAndSource();
    saveSupportOutputPolicy({
      tenantId: tenant.id, expectedVersion: 0,
      policy: { mode: 'enforce', blockedTerms: [], maxOutputChars: 16000, redactCredentials: true },
    });
    db.prepare("UPDATE x_support_output_policies SET payload_encrypted = 'corrupt' WHERE tenant_id = ?").run(tenant.id);
    completion.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({
        summary: 'Shipping question [1].',
        drafts: ['empathetic', 'direct', 'technical'].map(tone => ({ tone, text: 'Ships in 2 days [1].' })),
      }) } }],
      usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 },
    });
    await expect(generateSupportAgentCopilot({
      tenantId: tenant.id, actorId,
      input: { requestId: 'cop-corrupt-policy', conversationId: conv.id },
    })).rejects.toMatchObject({ status: 503, code: 'output_policy_unavailable' });
    expect(db.prepare('SELECT state, spent_tokens FROM x_support_desk_copilot_jobs WHERE tenant_id = ?').get(tenant.id))
      .toMatchObject({ state: 'failed', spent_tokens: 50 });
    expect(listSupportOutputEvents({ tenantId: tenant.id, limit: 50 }).items).toEqual([]);
  });
});
