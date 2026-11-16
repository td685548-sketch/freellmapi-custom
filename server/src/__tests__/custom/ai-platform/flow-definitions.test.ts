import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_FLOW_LIMITS,
  FLOW_LIMITS,
  type FlowDefinition,
} from '@freellmapi/shared/ai-platform-orchestrator.js';
import { getDb, initDb } from '../../../db/index.js';
import {
  RESERVED_PREFIXES,
  validateComboName,
} from '../../../custom/x-gateway/combos.js';
import { scopeBindingSettingsKey } from '../../../custom/ai-platform/mcp-client/store.js';
import { getPublishedPrompt } from '../../../custom/ai-platform/prompts/store.js';
import {
  createAgent,
  createFlow,
  deleteAgent,
  deleteFlow,
  getAgent,
  getAgentBySlug,
  getFlow,
  getFlowBySlug,
  getFlowDetail,
  isFlowGrantedToProfile,
  listAgents,
  listFlows,
  listGrantedFlowsForProfile,
  OrchestratorConflictError,
  OrchestratorNotFoundError,
  OrchestratorValidationError,
  publishFlow,
  setFlowGrants,
  updateAgent,
  updateFlowDraft,
  validateFlowDraftDefinition,
  validateFlowSlug,
} from '../../../custom/ai-platform/orchestrator/definitions.js';

function seedProfile(id: number, name = `profile-${id}`): void {
  getDb()
    .prepare(
      'INSERT INTO client_profiles (id, name, token_hash, encrypted_key, iv, auth_tag) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(id, name, `th-${id}`, `ek-${id}`, `iv-${id}`, `tag-${id}`);
}

function makeFlowDraft(overrides: Partial<FlowDefinition> = {}): FlowDefinition {
  return {
    kind: 'single',
    entryAgent: 'triage',
    agents: ['triage'],
    handoffs: { triage: [] },
    limits: { ...DEFAULT_FLOW_LIMITS },
    awaitingApprovalText: FLOW_LIMITS.defaultAwaitingApprovalText,
    approvalTtlHours: FLOW_LIMITS.defaultApprovalTtlHours,
    ...overrides,
  };
}

describe('orchestrator definitions & combo reserved prefix (T116, T122)', () => {
  beforeEach(() => {
    initDb(':memory:');
  });

  afterEach(() => {
    try {
      getDb().close();
    } catch {
      /* already closed */
    }
  });

  it('rejects flow: prefix in validateComboName (T122)', () => {
    expect(RESERVED_PREFIXES).toContain('flow:');
    expect(validateComboName('flow:triage')).not.toBeNull();
    expect(validateComboName('FLOW:support-bot')).not.toBeNull();
    expect(validateComboName('flow-triage')).toBeNull();
  });

  it('supports Agent CRUD, scope binding initialization, prompt publishing, revision conflicts, and 409 in_use delete guard', () => {
    seedProfile(1);

    const triage = createAgent(
      {
        slug: 'triage',
        name: 'Triage Agent',
        description: 'Routes incoming questions',
        model: 'auto',
        systemPrompt: 'You are the triage agent.',
        knowledgeScopeKind: 'profile',
        knowledgeScopeId: '1',
        outputPolicyScope: 'profile:1',
        maxOutputTokens: 1024,
      },
      10,
    );

    expect(triage.id).toBeGreaterThan(0);
    expect(triage.slug).toBe('triage');
    expect(triage.enabled).toBe(true);
    expect(triage.revision).toBe(1);
    expect(triage.publishedPromptVersion).toBe(1);
    expect(triage.systemPrompt).toBe('You are the triage agent.');

    const bindingSetting = getDb()
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(scopeBindingSettingsKey({ kind: 'agent', id: String(triage.id) })) as
      | { value: string }
      | undefined;
    expect(bindingSetting).toBeDefined();
    expect(JSON.parse(bindingSetting!.value)).toEqual({ enabled: true, maxRounds: null });

    expect(getAgent(triage.id)).toEqual(triage);
    expect(getAgentBySlug('triage')).toEqual(triage);
    expect(listAgents()).toHaveLength(1);

    // Update with stale revision throws 409 revision_conflict
    expect(() =>
      updateAgent(triage.id, { revision: 99, name: 'Stale' }, 10),
    ).toThrowError(OrchestratorConflictError);

    // Valid update publishes prompt v2
    const updated = updateAgent(
      triage.id,
      {
        revision: triage.revision,
        name: 'Triage Agent v2',
        systemPrompt: 'You are the updated triage agent.',
      },
      10,
    );
    expect(updated.revision).toBe(2);
    expect(updated.name).toBe('Triage Agent v2');
    expect(updated.publishedPromptVersion).toBe(2);
    expect(updated.systemPrompt).toBe('You are the updated triage agent.');

    // Validation errors on invalid agent inputs
    expect(() =>
      createAgent({ slug: 'Bad Slug!', name: '', model: '', maxOutputTokens: 0 }),
    ).toThrowError(OrchestratorValidationError);
    expect(() =>
      createAgent({
        slug: 'unpaired',
        name: 'Unpaired',
        model: 'auto',
        knowledgeScopeKind: 'profile',
        knowledgeScopeId: null,
      }),
    ).toThrowError(OrchestratorValidationError);

    // Reference triage in a flow -> deleteAgent must throw 409 in_use with flow details
    const flow = createFlow({
      slug: 'support-desk',
      name: 'Support Desk',
      draft: makeFlowDraft(),
    });

    let deleteErr: unknown;
    try {
      deleteAgent(triage.id);
    } catch (err) {
      deleteErr = err;
    }
    expect(deleteErr).toBeInstanceOf(OrchestratorConflictError);
    const conflict = deleteErr as OrchestratorConflictError;
    expect(conflict.status).toBe(409);
    expect(conflict.code).toBe('in_use');
    expect(conflict.details).toEqual({
      flows: [{ id: flow.id, slug: 'support-desk', name: 'Support Desk' }],
    });

    // Delete flow, then delete agent succeeds and cleans up prompt & settings rows
    deleteFlow(flow.id);
    expect(deleteAgent(triage.id)).toEqual({ ok: true });
    expect(() => getAgent(triage.id)).toThrowError(OrchestratorNotFoundError);
    expect(
      getPublishedPrompt({ kind: 'agent', id: String(triage.id) }),
    ).toBeNull();
    expect(
      getDb()
        .prepare('SELECT value FROM settings WHERE key = ?')
        .get(scopeBindingSettingsKey({ kind: 'agent', id: String(triage.id) })),
    ).toBeUndefined();
  });

  it('validates flow slug regex ^[a-z0-9-]{1,48}$ and all draft constraints + hard ceilings (T116)', () => {
    // Slug regex
    expect(() => validateFlowSlug('valid-flow-1')).not.toThrow();
    expect(() => validateFlowSlug('a'.repeat(48))).not.toThrow();
    for (const bad of ['', 'a'.repeat(49), 'Upper', 'has_underscore', 'flow:x', 'has space', 'auto', 'fusion']) {
      expect(() => validateFlowSlug(bad)).toThrowError(OrchestratorValidationError);
    }

    createAgent({ slug: 'triage', name: 'Triage', model: 'auto' });
    createAgent({ slug: 'disabled-bot', name: 'Disabled', model: 'auto', enabled: false });
    createAgent({ slug: 'tech', name: 'Tech', model: 'auto' });

    // Collects multiple errors: missing agent, disabled agent, missing entryAgent, invalid handoffs, ceiling violations
    let caught: unknown;
    try {
      validateFlowDraftDefinition({
        kind: 'handoff',
        entryAgent: 'not-in-list',
        agents: ['triage', 'disabled-bot', 'ghost'],
        handoffs: {
          triage: ['triage', 'unknown-target'],
          ghost2: ['triage'],
        },
        limits: {
          maxSteps: 51,
          maxToolCalls: 101,
          maxHandoffs: 11,
          maxTokens: 500_001,
          maxSeconds: 601,
        },
        awaitingApprovalText: 'Waiting',
        approvalTtlHours: 169,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(OrchestratorValidationError);
    const valErr = caught as OrchestratorValidationError;
    expect(valErr.status).toBe(422);
    expect(valErr.code).toBe('invalid_flow_definition');

    const fields = valErr.errors.map((e) => e.field);
    expect(fields).toContain('agents');
    expect(fields).toContain('entryAgent');
    expect(fields).toContain('handoffs.triage');
    expect(fields).toContain('handoffs.ghost2');
    expect(fields).toContain('limits.maxSteps');
    expect(fields).toContain('limits.maxToolCalls');
    expect(fields).toContain('limits.maxHandoffs');
    expect(fields).toContain('limits.maxTokens');
    expect(fields).toContain('limits.maxSeconds');
    expect(fields).toContain('approvalTtlHours');

    const messages = valErr.errors.map((e) => e.message).join(' | ');
    expect(messages).toContain("Agent 'ghost' does not exist");
    expect(messages).toContain("Agent 'disabled-bot' is disabled");
    expect(messages).toContain('cannot hand off to itself');

    // Single-agent flow rejects non-empty handoffs
    expect(() =>
      validateFlowDraftDefinition({
        kind: 'single',
        entryAgent: 'triage',
        agents: ['triage', 'tech'],
        handoffs: { triage: ['tech'], tech: [] },
        limits: { ...DEFAULT_FLOW_LIMITS },
        awaitingApprovalText: 'Wait',
        approvalTtlHours: 24,
      }),
    ).toThrowError(OrchestratorValidationError);

    // Exact hard ceilings pass
    expect(() =>
      validateFlowDraftDefinition({
        kind: 'handoff',
        entryAgent: 'triage',
        agents: ['triage', 'tech'],
        handoffs: { triage: ['tech'], tech: ['triage'] },
        limits: {
          maxSteps: 50,
          maxToolCalls: 100,
          maxHandoffs: 10,
          maxTokens: 500_000,
          maxSeconds: 600,
        },
        awaitingApprovalText: 'Wait',
        approvalTtlHours: 168,
      }),
    ).not.toThrow();
  });

  it('snapshots agent prompt versions on publishFlow even after agent prompt is edited (T116)', () => {
    const triage = createAgent({
      slug: 'triage',
      name: 'Triage',
      model: 'auto',
      systemPrompt: 'Triage prompt v1',
    });
    const tech = createAgent({
      slug: 'tech',
      name: 'Tech',
      model: 'gpt-4o',
      systemPrompt: 'Tech prompt v1',
    });

    const created = createFlow({
      slug: 'helpdesk',
      name: 'Helpdesk',
      draft: makeFlowDraft({
        kind: 'handoff',
        entryAgent: 'triage',
        agents: ['triage', 'tech'],
        handoffs: { triage: ['tech'], tech: [] },
      }),
    });
    expect(created.publishedVersion).toBe(0);
    expect(created.published).toBeNull();
    expect(created.revision).toBe(1);

    const published1 = publishFlow(created.id, created.revision, 1);
    expect(published1.publishedVersion).toBe(1);
    expect(published1.revision).toBe(2);
    expect(published1.published?.agentPromptVersions).toEqual({
      triage: 1,
      tech: 1,
    });
    expect(published1.published?.agentSnapshots?.triage?.promptBody).toBe('Triage prompt v1');
    expect(published1.published?.agentSnapshots?.tech?.promptBody).toBe('Tech prompt v1');

    // Edit triage prompt -> agent moves to v2, but published flow v1 snapshot stays pinned at v1
    updateAgent(triage.id, { revision: triage.revision, systemPrompt: 'Triage prompt v2' }, 1);
    const reloaded = getFlow(created.id);
    expect(reloaded.published?.agentPromptVersions).toEqual({
      triage: 1,
      tech: 1,
    });
    expect(reloaded.published?.agentSnapshots?.triage?.promptVersion).toBe(1);
    expect(reloaded.published?.agentSnapshots?.triage?.promptBody).toBe('Triage prompt v1');

    // Re-publish captures v2
    const published2 = publishFlow(created.id, reloaded.revision, 1);
    expect(published2.publishedVersion).toBe(2);
    expect(published2.published?.agentPromptVersions).toEqual({
      triage: 2,
      tech: 1,
    });
    expect(published2.published?.agentSnapshots?.triage?.promptBody).toBe('Triage prompt v2');
    expect(tech.id).toBeGreaterThan(0);
  });

  it('handles draft revision conflicts, flow grants, and granted flow listings', () => {
    seedProfile(1, 'Alpha');
    seedProfile(2, 'Beta');
    createAgent({ slug: 'triage', name: 'Triage', model: 'auto' });

    const flow = createFlow({
      slug: 'alpha-flow',
      name: 'Alpha Flow',
      draft: makeFlowDraft(),
    });
    expect(listFlows()).toHaveLength(1);
    expect(getFlowBySlug('alpha-flow')?.id).toBe(flow.id);

    // Grants work even before publish, but listGrantedFlowsForProfile only exposes published + enabled flows
    setFlowGrants(flow.id, [1, 1]);
    expect(getFlowDetail(flow.id).grantedProfileIds).toEqual([1]);
    expect(isFlowGrantedToProfile(flow.id, 1)).toBe(true);
    expect(isFlowGrantedToProfile(flow.id, 2)).toBe(false);
    expect(listGrantedFlowsForProfile(1)).toEqual([]);

    // Non-existent profile fails 404
    expect(() => setFlowGrants(flow.id, [999])).toThrowError(OrchestratorNotFoundError);

    // Stale revision on draft update or publish throws 409 with current detail
    const updatedDraft = updateFlowDraft(flow.id, {
      revision: flow.revision,
      name: 'Alpha Flow Updated',
      draft: makeFlowDraft({ awaitingApprovalText: 'Custom hold text' }),
    });
    expect(updatedDraft.revision).toBe(2);

    let conflictErr: unknown;
    try {
      updateFlowDraft(flow.id, { revision: 1, draft: makeFlowDraft() });
    } catch (err) {
      conflictErr = err;
    }
    expect(conflictErr).toBeInstanceOf(OrchestratorConflictError);
    expect((conflictErr as OrchestratorConflictError).code).toBe('revision_conflict');
    expect(
      ((conflictErr as OrchestratorConflictError).details as { current: { flow: { revision: number } } })
        .current.flow.revision,
    ).toBe(2);

    expect(() => publishFlow(flow.id, 1)).toThrowError(OrchestratorConflictError);

    publishFlow(flow.id, updatedDraft.revision);
    expect(listGrantedFlowsForProfile(1).map((f) => f.slug)).toEqual(['alpha-flow']);
    expect(listGrantedFlowsForProfile(2)).toEqual([]);

    // Disabling flow hides it from listGrantedFlowsForProfile
    const latest = getFlow(flow.id);
    updateFlowDraft(flow.id, {
      revision: latest.revision,
      enabled: false,
      draft: latest.draft,
    });
    expect(listGrantedFlowsForProfile(1)).toEqual([]);
  });
});
