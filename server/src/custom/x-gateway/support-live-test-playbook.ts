import { randomUUID } from 'node:crypto';
import type { SupportEvidenceRole } from '@freellmapi/shared/support-evidence.js';
import type {
  SupportLiveTestPersonaInput,
  SupportLiveTestPlaybook,
  SupportLiveTestPlaybookCase,
  SupportLiveTestPlaybookCaseResult,
  SupportLiveTestPlaybookExpectation,
  SupportLiveTestPlaybookRunResponse,
} from '@freellmapi/shared/support-service-desk-live-test.js';
import { getDb, type Db } from '../../db/index.js';
import { executeSupportChatPipeline } from './support-router.js';
import { dispatchRuntimeTurn } from './support-runtime-router.js';
import {
  getSupportDeskWidgetConfig,
  saveSupportDeskIntake,
} from './support-service-desk-store.js';
import {
  computeSupportDeskIntakeSchemaHash,
  validateSupportDeskIntake,
} from './support-widget-profile.js';
import {
  mintSupportUserToken,
  verifySupportUserToken,
  type SupportTenant,
  type SupportUserContext,
} from './support-store.js';
import {
  purgeSpecificLiveTestRecords,
  runWithLiveTestContext,
} from './support-live-test-sandbox.js';

const PLAYBOOKS_KEY = 'x_gateway_support_live_test_playbooks_v1';
const MAX_PLAYBOOK_CASES = 20;
const ALLOWED_EXPECTATIONS: readonly SupportLiveTestPlaybookExpectation[] = [
  'any_reply',
  'cited',
  'abstained',
  'guardrail_blocked',
  'tool_called',
  'guest_denied',
];

export class SupportLiveTestPlaybookError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return false;
  const proto = Object.getPrototypeOf(val);
  return proto === Object.prototype || proto === null;
}

function assertAllowedKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.getOwnPropertyNames(obj)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype' || !allowed.includes(key)) {
      throw new SupportLiveTestPlaybookError(400, 'invalid_input', `Unsupported field "${key}" in ${label}.`);
    }
  }
}

function ensureSettingsTable(db: Db): void {
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
}

function readPlaybookStore(db: Db): Record<string, SupportLiveTestPlaybook> {
  ensureSettingsTable(db);
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(PLAYBOOKS_KEY) as
    | { value: string }
    | undefined;
  if (!row?.value) return {};
  try {
    const parsed = JSON.parse(row.value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, SupportLiveTestPlaybook>)
      : {};
  } catch {
    return {};
  }
}

function writePlaybookStore(db: Db, store: Record<string, SupportLiveTestPlaybook>): void {
  ensureSettingsTable(db);
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(PLAYBOOKS_KEY, JSON.stringify(store));
}

function validatePersonaInput(raw: unknown, index: number): SupportLiveTestPersonaInput {
  if (!isPlainObject(raw)) {
    throw new SupportLiveTestPlaybookError(400, 'invalid_input', `cases[${index}].persona must be an object.`);
  }
  assertAllowedKeys(
    raw,
    ['mode', 'userId', 'role', 'name', 'email', 'permissions', 'ttlSeconds'],
    `cases[${index}].persona`,
  );

  const mode = raw.mode;
  if (mode !== 'guest' && mode !== 'authenticated') {
    throw new SupportLiveTestPlaybookError(
      400,
      'invalid_input',
      `cases[${index}].persona.mode must be "guest" or "authenticated".`,
    );
  }

  if (mode === 'guest') {
    return { mode: 'guest', role: 'guest' };
  }

  const userId = typeof raw.userId === 'string' ? raw.userId.trim() : '';
  if (!userId || userId.length > 128) {
    throw new SupportLiveTestPlaybookError(
      400,
      'invalid_input',
      `cases[${index}].persona.userId must be 1..128 characters for authenticated mode.`,
    );
  }
  const role = typeof raw.role === 'string' ? raw.role.trim() : '';
  if (!role || role.length > 64) {
    throw new SupportLiveTestPlaybookError(
      400,
      'invalid_input',
      `cases[${index}].persona.role must be 1..64 characters for authenticated mode.`,
    );
  }

  let name: string | undefined;
  if (raw.name !== undefined) {
    if (typeof raw.name !== 'string' || raw.name.trim().length > 128) {
      throw new SupportLiveTestPlaybookError(
        400,
        'invalid_input',
        `cases[${index}].persona.name must be up to 128 characters.`,
      );
    }
    name = raw.name.trim() || undefined;
  }

  let email: string | undefined;
  if (raw.email !== undefined) {
    if (typeof raw.email !== 'string' || raw.email.trim().length > 254) {
      throw new SupportLiveTestPlaybookError(
        400,
        'invalid_input',
        `cases[${index}].persona.email must be up to 254 characters.`,
      );
    }
    email = raw.email.trim() || undefined;
  }

  let permissions: string[] | undefined;
  if (raw.permissions !== undefined) {
    if (
      !Array.isArray(raw.permissions) ||
      raw.permissions.length > 50 ||
      !raw.permissions.every((p) => typeof p === 'string' && p.trim().length > 0 && p.trim().length <= 128)
    ) {
      throw new SupportLiveTestPlaybookError(
        400,
        'invalid_input',
        `cases[${index}].persona.permissions must be at most 50 non-empty strings.`,
      );
    }
    const clean = raw.permissions.map((p) => p.trim());
    if (clean.length > 0) permissions = clean;
  }

  return {
    mode: 'authenticated',
    userId,
    role,
    ...(name ? { name } : {}),
    ...(email ? { email } : {}),
    ...(permissions ? { permissions } : {}),
  };
}

export function validateSupportPlaybookCases(rawCases: unknown): SupportLiveTestPlaybookCase[] {
  if (!Array.isArray(rawCases)) {
    throw new SupportLiveTestPlaybookError(400, 'invalid_input', 'cases must be an array.');
  }
  if (rawCases.length > MAX_PLAYBOOK_CASES) {
    throw new SupportLiveTestPlaybookError(
      400,
      'invalid_input',
      `Playbook cannot exceed ${MAX_PLAYBOOK_CASES} test cases.`,
    );
  }

  const seenIds = new Set<string>();
  const normalized: SupportLiveTestPlaybookCase[] = [];

  for (let i = 0; i < rawCases.length; i += 1) {
    const raw = rawCases[i];
    if (!isPlainObject(raw)) {
      throw new SupportLiveTestPlaybookError(400, 'invalid_input', `cases[${i}] must be an object.`);
    }
    assertAllowedKeys(
      raw,
      ['id', 'title', 'persona', 'message', 'expectation', 'expectedText', 'expectedTool'],
      `cases[${i}]`,
    );

    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    if (!id || id.length > 64) {
      throw new SupportLiveTestPlaybookError(400, 'invalid_input', `cases[${i}].id must be 1..64 characters.`);
    }
    if (seenIds.has(id)) {
      throw new SupportLiveTestPlaybookError(400, 'invalid_input', `Duplicate case id "${id}".`);
    }
    seenIds.add(id);

    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    if (!title || title.length > 120) {
      throw new SupportLiveTestPlaybookError(
        400,
        'invalid_input',
        `cases[${i}].title must be 1..120 characters.`,
      );
    }

    const message = typeof raw.message === 'string' ? raw.message.trim() : '';
    if (!message || message.length > 2000) {
      throw new SupportLiveTestPlaybookError(
        400,
        'invalid_input',
        `cases[${i}].message must be 1..2000 characters.`,
      );
    }

    const expectation = raw.expectation;
    if (
      typeof expectation !== 'string' ||
      !(ALLOWED_EXPECTATIONS as readonly string[]).includes(expectation)
    ) {
      throw new SupportLiveTestPlaybookError(
        400,
        'invalid_input',
        `cases[${i}].expectation must be one of: ${ALLOWED_EXPECTATIONS.join(', ')}.`,
      );
    }

    let expectedText: string | undefined;
    if (raw.expectedText !== undefined) {
      if (typeof raw.expectedText !== 'string' || raw.expectedText.trim().length > 500) {
        throw new SupportLiveTestPlaybookError(
          400,
          'invalid_input',
          `cases[${i}].expectedText must be at most 500 characters.`,
        );
      }
      expectedText = raw.expectedText.trim() || undefined;
    }

    let expectedTool: string | undefined;
    if (raw.expectedTool !== undefined) {
      if (typeof raw.expectedTool !== 'string' || raw.expectedTool.trim().length > 128) {
        throw new SupportLiveTestPlaybookError(
          400,
          'invalid_input',
          `cases[${i}].expectedTool must be at most 128 characters.`,
        );
      }
      expectedTool = raw.expectedTool.trim() || undefined;
    }

    normalized.push({
      id,
      title,
      persona: validatePersonaInput(raw.persona, i),
      message,
      expectation: expectation as SupportLiveTestPlaybookExpectation,
      ...(expectedText ? { expectedText } : {}),
      ...(expectedTool ? { expectedTool } : {}),
    });
  }

  return normalized;
}

export function getSupportLiveTestPlaybook(tenantId: number): SupportLiveTestPlaybook {
  const db = getDb();
  const store = readPlaybookStore(db);
  const existing = store[String(tenantId)];
  if (!existing) {
    return {
      version: 1,
      updatedAt: new Date(0).toISOString(),
      cases: [],
    };
  }
  return existing;
}

export function saveSupportLiveTestPlaybook(
  tenantId: number,
  rawCases: unknown,
): SupportLiveTestPlaybook {
  const cases = validateSupportPlaybookCases(rawCases);
  const db = getDb();
  const tid = String(tenantId);
  const store = readPlaybookStore(db);
  const current = store[tid];
  const next: SupportLiveTestPlaybook = {
    version: current ? current.version + 1 : 1,
    updatedAt: new Date().toISOString(),
    cases,
  };
  store[tid] = next;
  writePlaybookStore(db, store);
  return next;
}

function mintPlaybookPersonaToken(
  tenant: SupportTenant,
  persona: SupportLiveTestPersonaInput,
): { token: string; userContext: SupportUserContext } {
  if (persona.mode === 'guest') {
    const guestRoleCfg = tenant.rolesConfig.find((r) => r.role === 'guest');
    const guestPerms = guestRoleCfg?.permissions ?? [];
    const token = mintSupportUserToken(tenant.id, {
      userId: `guest_pbk_${randomUUID()}`,
      role: 'guest',
      permissions: guestPerms,
      ttlSeconds: 300,
    });
    return { token, userContext: verifySupportUserToken(tenant.id, token) };
  }

  const role = persona.role ?? 'customer';
  const roleCfg = tenant.rolesConfig.find((r) => r.role === role);
  const mergedPermissions = [...new Set([...(roleCfg?.permissions ?? []), ...(persona.permissions ?? [])])];
  const token = mintSupportUserToken(tenant.id, {
    userId: persona.userId ?? 'cust_playbook',
    name: persona.name,
    email: persona.email,
    role,
    permissions: mergedPermissions,
    ttlSeconds: 300,
  });
  return { token, userContext: verifySupportUserToken(tenant.id, token) };
}

function synthesizePlaybookIntakeValues(tenantId: number): {
  configVersion: number;
  schemaHash: string;
  validatedValues: Record<string, string | number>;
} | null {
  const cfg = getSupportDeskWidgetConfig(tenantId);
  if (!cfg.enabled || !cfg.intake.required || cfg.intake.fields.length === 0) {
    return null;
  }

  const rawValues: Record<string, string | number> = {};
  for (const field of cfg.intake.fields) {
    switch (field.type) {
      case 'email':
        rawValues[field.key] = 'playbook@example.com';
        break;
      case 'number':
        rawValues[field.key] = 1;
        break;
      case 'select':
        rawValues[field.key] = field.options?.[0] ?? 'default';
        break;
      case 'text':
      default:
        rawValues[field.key] = 'playbook-test';
        break;
    }
  }

  const validatedValues = validateSupportDeskIntake(cfg, rawValues);
  return {
    configVersion: cfg.version,
    schemaHash: computeSupportDeskIntakeSchemaHash(cfg),
    validatedValues,
  };
}

function toolMatchesExpected(calledTools: readonly string[], expectedTool: string): boolean {
  const target = expectedTool.trim().toLowerCase();
  if (!target) return true;
  return calledTools.some((t) => {
    const lower = t.toLowerCase();
    return lower === target || lower === `webhook__${target}` || lower.endsWith(`__${target}`);
  });
}

function extractThrownErrorInfo(err: unknown): { status: number; code: string; message: string } {
  if (err && typeof err === 'object') {
    const rec = err as { status?: unknown; code?: unknown; message?: unknown };
    const status = typeof rec.status === 'number' && rec.status >= 400 ? rec.status : 500;
    const code = typeof rec.code === 'string' && rec.code ? rec.code : 'runtime_error';
    const message = typeof rec.message === 'string' ? rec.message : 'Support runtime error.';
    return { status, code, message };
  }
  return { status: 500, code: 'runtime_error', message: 'Support runtime error.' };
}

export async function runSupportLiveTestPlaybook(
  tenant: SupportTenant,
  overrideCases?: unknown,
): Promise<SupportLiveTestPlaybookRunResponse> {
  const cases =
    overrideCases !== undefined
      ? validateSupportPlaybookCases(overrideCases)
      : getSupportLiveTestPlaybook(tenant.id).cases;

  const ranAt = new Date().toISOString();
  if (cases.length === 0) {
    return {
      ok: true,
      tenantId: tenant.id,
      ranAt,
      passedCount: 0,
      failedCount: 0,
      results: [],
    };
  }

  const createdConversationIds: string[] = [];
  const createdActionIds: string[] = [];
  const createdIntakeRequestIds: string[] = [];
  const createdChatRequestIds: string[] = [];
  const results: SupportLiveTestPlaybookCaseResult[] = [];

  try {
    await runWithLiveTestContext(tenant.id, async () => {
      for (const testCase of cases) {
        const started = Date.now();

        if (!tenant.enabled) {
          results.push({
            caseId: testCase.id,
            title: testCase.title,
            passed: false,
            status: 403,
            durationMs: Date.now() - started,
            actualOutcome: 'error',
            citationsCount: 0,
            toolsCalled: [],
            errorCode: 'tenant_disabled',
            reason: 'Support tenant is disabled.',
          });
          continue;
        }

        if (testCase.persona.mode === 'guest' && !tenant.allowGuest) {
          const passed = testCase.expectation === 'guest_denied';
          results.push({
            caseId: testCase.id,
            title: testCase.title,
            passed,
            status: 403,
            durationMs: Date.now() - started,
            actualOutcome: 'guest_denied',
            citationsCount: 0,
            toolsCalled: [],
            errorCode: 'guest_not_allowed',
            ...(passed
              ? {}
              : { reason: 'Guest session denied because tenant allowGuest=false.' }),
          });
          continue;
        }

        const chatRequestId = `pbk_${randomUUID().replace(/-/g, '')}`;
        createdChatRequestIds.push(chatRequestId);

        try {
          const { token, userContext } = mintPlaybookPersonaToken(tenant, testCase.persona);

          let intakeReceiptId: string | undefined;
          const synthIntake = synthesizePlaybookIntakeValues(tenant.id);
          if (synthIntake) {
            const intakeReqId = `pbk_in_${randomUUID().replace(/-/g, '')}`;
            createdIntakeRequestIds.push(intakeReqId);
            const receipt = saveSupportDeskIntake({
              tenantId: tenant.id,
              userId: userContext.userId,
              role: userContext.role as SupportEvidenceRole,
              input: {
                requestId: intakeReqId,
                configVersion: synthIntake.configVersion,
                values: synthIntake.validatedValues,
              },
              schemaHash: synthIntake.schemaHash,
              validatedValues: synthIntake.validatedValues,
            });
            intakeReceiptId = receipt.intakeReceiptId;
          }

          interface PlaybookTurnOutput {
            reply?: string;
            toolTrace?: Array<{ name?: string; toolName?: string; error?: string }>;
            choices?: Array<{ finish_reason?: string }>;
            runtime?: {
              conversationId?: string;
              replySource?: string;
              citations?: unknown[];
              pendingActions?: Array<{ id?: string }>;
              output?: { action?: string };
              evidence?: { status?: string; citations?: unknown[] };
            };
          }

          const result = (await dispatchRuntimeTurn({
            tenant,
            userContext,
            input: {
              tenantKey: tenant.publicKey,
              contextToken: token,
              requestId: chatRequestId,
              messages: [{ role: 'user', content: testCase.message }],
              ...(intakeReceiptId !== undefined ? { intakeReceiptId } : {}),
            },
            generate: async (genCtx) =>
              executeSupportChatPipeline({
                tenant: genCtx.tenant,
                userContext: genCtx.userContext,
                messages: genCtx.messages,
                model: genCtx.model,
                hooks: {
                  trustedContext: genCtx.trustedContext,
                  disableTools: genCtx.disableTools,
                  maxCompletionTokens: genCtx.policy?.maxCompletionTokens,
                  maxModelCalls: genCtx.policy?.maxModelCalls,
                  maxToolCalls: genCtx.policy?.maxToolCalls,
                  maxContextChars: genCtx.policy?.maxContextChars,
                  maxToolResultChars: genCtx.policy?.maxToolResultChars,
                  maskToolData: genCtx.maskToolData,
                  invokeWebhook: genCtx.invokeWebhook,
                  signal: genCtx.signal,
                  beforeModelCall: genCtx.beforeModelCall,
                  recordModelUsage: genCtx.recordModelUsage,
                },
              }),
          })) as PlaybookTurnOutput;

          const runtime = result.runtime ?? {};
          if (runtime.conversationId) {
            createdConversationIds.push(runtime.conversationId);
          }
          if (Array.isArray(runtime.pendingActions)) {
            for (const act of runtime.pendingActions) {
              if (act?.id) createdActionIds.push(act.id);
            }
          }

          const replyText = typeof result.reply === 'string' ? result.reply : '';
          const replyPreview =
            replyText.length > 160 ? `${replyText.slice(0, 157)}...` : replyText;
          const citationsCount = Array.isArray(runtime.citations)
            ? runtime.citations.length
            : Array.isArray(runtime.evidence?.citations)
              ? runtime.evidence.citations.length
              : 0;
          const toolsCalled = Array.isArray(result.toolTrace)
            ? [
                ...new Set(
                  result.toolTrace
                    .filter((t) => !t.error)
                    .map((t) => String(t.name ?? t.toolName ?? '').trim())
                    .filter(Boolean),
                ),
              ]
            : [];

          const isOutputBlocked =
            runtime.output?.action === 'block' ||
            result.choices?.[0]?.finish_reason === 'content_filter';
          const isAbstained =
            runtime.evidence?.status === 'abstained' ||
            runtime.replySource === 'knowledge_abstention';
          const hasCitations = citationsCount > 0;
          const hasTools = toolsCalled.length > 0;

          let actualOutcome: SupportLiveTestPlaybookExpectation;
          if (isOutputBlocked) {
            actualOutcome = 'guardrail_blocked';
          } else if (isAbstained) {
            actualOutcome = 'abstained';
          } else if (testCase.expectation === 'cited' && hasCitations) {
            actualOutcome = 'cited';
          } else if (testCase.expectation === 'tool_called' && hasTools) {
            actualOutcome = 'tool_called';
          } else if (hasCitations) {
            actualOutcome = 'cited';
          } else if (hasTools) {
            actualOutcome = 'tool_called';
          } else {
            actualOutcome = 'any_reply';
          }

          let passed = false;
          let reason: string | undefined;

          switch (testCase.expectation) {
            case 'any_reply':
              passed = actualOutcome !== 'guardrail_blocked' && replyText.trim().length > 0;
              if (!passed) {
                reason =
                  actualOutcome === 'guardrail_blocked'
                    ? 'Reply was blocked by guardrails/output filter.'
                    : 'Reply was empty.';
              }
              break;
            case 'cited':
              passed = !isOutputBlocked && hasCitations;
              if (!passed) {
                reason = `Expected cited response, got outcome "${actualOutcome}" with 0 citations.`;
              }
              break;
            case 'abstained':
              passed = actualOutcome === 'abstained';
              if (!passed) {
                reason = `Expected abstained response, got "${actualOutcome}".`;
              }
              break;
            case 'guardrail_blocked':
              passed = actualOutcome === 'guardrail_blocked';
              if (!passed) {
                reason = `Expected guardrail block, got "${actualOutcome}".`;
              }
              break;
            case 'tool_called':
              if (!hasTools) {
                passed = false;
                reason = 'Expected at least one successful tool call, got none.';
              } else if (testCase.expectedTool && !toolMatchesExpected(toolsCalled, testCase.expectedTool)) {
                passed = false;
                reason = `Expected tool "${testCase.expectedTool}", called: ${toolsCalled.join(', ')}.`;
              } else {
                passed = true;
              }
              break;
            case 'guest_denied':
              passed = false;
              reason = 'Expected guest access denial, but turn succeeded.';
              break;
          }

          if (passed && testCase.expectedText) {
            if (!replyText.toLowerCase().includes(testCase.expectedText.toLowerCase())) {
              passed = false;
              reason = `Reply did not contain expected text "${testCase.expectedText}".`;
            }
          }
          if (passed && testCase.expectation === 'any_reply' && testCase.expectedTool) {
            if (!toolMatchesExpected(toolsCalled, testCase.expectedTool)) {
              passed = false;
              reason = `Expected tool "${testCase.expectedTool}", called: ${toolsCalled.join(', ') || 'none'}.`;
            }
          }

          results.push({
            caseId: testCase.id,
            title: testCase.title,
            passed,
            status: 200,
            durationMs: Date.now() - started,
            actualOutcome,
            replyPreview,
            citationsCount,
            toolsCalled,
            ...(reason ? { reason } : {}),
          });
        } catch (err) {
          const info = extractThrownErrorInfo(err);
          const actualOutcome: SupportLiveTestPlaybookExpectation | 'error' =
            info.code === 'guardrail_blocked'
              ? 'guardrail_blocked'
              : info.code === 'guest_not_allowed'
                ? 'guest_denied'
                : 'error';
          const passed = actualOutcome !== 'error' && testCase.expectation === actualOutcome;
          results.push({
            caseId: testCase.id,
            title: testCase.title,
            passed,
            status: info.status,
            durationMs: Date.now() - started,
            actualOutcome,
            citationsCount: 0,
            toolsCalled: [],
            errorCode: info.code,
            ...(passed ? {} : { reason: info.message }),
          });
        }
      }
    });
  } finally {
    purgeSpecificLiveTestRecords(tenant.id, {
      conversationIds: createdConversationIds,
      actionIds: createdActionIds,
      intakeRequestIds: createdIntakeRequestIds,
      chatRequestIds: createdChatRequestIds,
    });
  }

  const passedCount = results.filter((r) => r.passed).length;
  return {
    ok: true,
    tenantId: tenant.id,
    ranAt,
    passedCount,
    failedCount: results.length - passedCount,
    results,
  };
}
