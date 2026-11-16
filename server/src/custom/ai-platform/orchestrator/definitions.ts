import type { Scope, ScopeKind } from '@freellmapi/shared/ai-platform.js';
import {
  AGENT_SLUG_REGEX,
  FLOW_LIMITS,
  FLOW_SLUG_REGEX,
  type AgentInput,
  type AgentPatchInput,
  type AgentView,
  type FlowCreateInput,
  type FlowDefinition,
  type FlowDetailView,
  type FlowDraftInput,
  type FlowLimitsConfig,
  type FlowValidationIssue,
  type FlowView,
  type PublishedAgentSnapshot,
  type PublishedFlowDefinition,
} from '@freellmapi/shared/ai-platform-orchestrator.js';
import { getDb, type Db } from '../../../db/index.js';
import { scopeBindingSettingsKey } from '../mcp-client/store.js';
import {
  getPromptScopeState,
  getPublishedPrompt,
  PromptStoreError,
  PromptValidationError,
  publish,
  saveDraft,
} from '../prompts/store.js';
import { normalizeScope, purgeScope } from '../scope.js';

// ── Domain Errors ────────────────────────────────────────────────────────────

export class OrchestratorError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'OrchestratorError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class OrchestratorValidationError extends OrchestratorError {
  readonly errors: FlowValidationIssue[];

  constructor(
    errors: FlowValidationIssue[],
    message?: string,
    code = 'invalid_flow_definition',
  ) {
    const summary =
      message ??
      (errors.length > 0
        ? errors.map((e) => `${e.field}: ${e.message}`).join('; ')
        : 'Validation failed.');
    super(422, code, summary, { errors });
    this.name = 'OrchestratorValidationError';
    this.errors = errors;
  }
}

export class OrchestratorConflictError extends OrchestratorError {
  constructor(
    code: 'revision_conflict' | 'in_use' | 'not_ready' | string,
    message: string,
    details?: unknown,
  ) {
    super(409, code, message, details);
    this.name = 'OrchestratorConflictError';
  }
}

export class OrchestratorNotFoundError extends OrchestratorError {
  constructor(message = 'Resource not found.', code = 'not_found') {
    super(404, code, message);
    this.name = 'OrchestratorNotFoundError';
  }
}

// ── SQL Row Types ────────────────────────────────────────────────────────────

interface AgentRow {
  id: number;
  slug: string;
  name: string;
  description: string;
  model: string;
  knowledge_scope_kind: ScopeKind | null;
  knowledge_scope_id: string | null;
  output_policy_scope: string | null;
  max_output_tokens: number | null;
  enabled: number;
  revision: number;
}

interface FlowRow {
  id: number;
  slug: string;
  name: string;
  description: string;
  draft_json: string;
  published_json: string | null;
  published_version: number;
  enabled: number;
  revision: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const RESERVED_FLOW_SLUGS = new Set(['auto', 'fusion']);

function hasTable(db: Db, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonSafe<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toAgentView(row: AgentRow): AgentView {
  const prompt = getPublishedPrompt({ kind: 'agent', id: String(row.id) });
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    model: row.model,
    knowledgeScopeKind: row.knowledge_scope_kind ?? null,
    knowledgeScopeId: row.knowledge_scope_id ?? null,
    outputPolicyScope: row.output_policy_scope ?? null,
    maxOutputTokens: row.max_output_tokens ?? null,
    enabled: row.enabled === 1,
    revision: row.revision,
    publishedPromptVersion: prompt ? prompt.version : null,
    systemPrompt: prompt ? prompt.body : '',
  };
}

function toFlowView(row: FlowRow): FlowView {
  const draft = parseJsonSafe<FlowDefinition>(row.draft_json, {
    kind: 'single',
    entryAgent: '',
    agents: [],
    handoffs: {},
    limits: {
      maxSteps: FLOW_LIMITS.defaultMaxSteps,
      maxToolCalls: FLOW_LIMITS.defaultMaxToolCalls,
      maxHandoffs: FLOW_LIMITS.defaultMaxHandoffs,
      maxTokens: FLOW_LIMITS.defaultMaxTokens,
      maxSeconds: FLOW_LIMITS.defaultMaxSeconds,
    },
    awaitingApprovalText: FLOW_LIMITS.defaultAwaitingApprovalText,
    approvalTtlHours: FLOW_LIMITS.defaultApprovalTtlHours,
  });
  const published = row.published_json
    ? parseJsonSafe<PublishedFlowDefinition | null>(row.published_json, null)
    : null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    draft,
    published,
    publishedVersion: row.published_version,
    enabled: row.enabled === 1,
    revision: row.revision,
  };
}

function getAgentRowOrThrow(db: Db, id: number): AgentRow {
  if (!Number.isInteger(id) || id <= 0) {
    throw new OrchestratorNotFoundError(`Agent ${id} not found.`);
  }
  const row = db
    .prepare('SELECT * FROM custom_ai_agents WHERE id = ?')
    .get(id) as AgentRow | undefined;
  if (!row) {
    throw new OrchestratorNotFoundError(`Agent ${id} not found.`);
  }
  return row;
}

function getFlowRowOrThrow(db: Db, id: number): FlowRow {
  if (!Number.isInteger(id) || id <= 0) {
    throw new OrchestratorNotFoundError(`Flow ${id} not found.`);
  }
  const row = db
    .prepare('SELECT * FROM custom_ai_flows WHERE id = ?')
    .get(id) as FlowRow | undefined;
  if (!row) {
    throw new OrchestratorNotFoundError(`Flow ${id} not found.`);
  }
  return row;
}

function validateKnowledgeScopePair(
  kind: unknown,
  id: unknown,
  issues: FlowValidationIssue[],
): { kind: ScopeKind | null; id: string | null } {
  const hasKind = kind !== undefined && kind !== null && kind !== '';
  const hasId = id !== undefined && id !== null && String(id).trim() !== '';

  if (!hasKind && !hasId) {
    return { kind: null, id: null };
  }
  if (!hasKind || !hasId) {
    issues.push({
      field: 'knowledgeScopeKind',
      message: 'knowledgeScopeKind and knowledgeScopeId must both be set or both be null.',
    });
    return { kind: null, id: null };
  }
  if (kind !== 'profile' && kind !== 'support_tenant' && kind !== 'agent') {
    issues.push({
      field: 'knowledgeScopeKind',
      message: `Invalid knowledgeScopeKind '${String(kind)}'.`,
    });
    return { kind: null, id: null };
  }
  try {
    const normalized = normalizeScope({ kind, id: String(id) });
    return { kind: normalized.kind, id: normalized.id };
  } catch (err) {
    issues.push({
      field: 'knowledgeScopeId',
      message: err instanceof Error ? err.message : 'Invalid knowledge scope id.',
    });
    return { kind: null, id: null };
  }
}

function saveAndPublishAgentPrompt(
  agentId: number,
  body: string,
  actorId: number | null,
): void {
  const scope: Scope = { kind: 'agent', id: String(agentId) };
  try {
    const state = getPromptScopeState(scope);
    saveDraft(scope, { body, revision: state.head.revision }, actorId);
    publish(scope, state.head.revision + 1, actorId);
  } catch (err) {
    if (err instanceof PromptValidationError) {
      throw new OrchestratorValidationError(
        [{ field: 'systemPrompt', message: err.message }],
        err.message,
      );
    }
    if (err instanceof PromptStoreError) {
      throw new OrchestratorError(err.status, err.code, err.message);
    }
    throw err;
  }
}

function flowReferencesAgent(def: unknown, agentSlug: string): boolean {
  if (!isPlainObject(def)) return false;
  if (def.entryAgent === agentSlug) return true;
  if (Array.isArray(def.agents) && def.agents.includes(agentSlug)) return true;
  if (isPlainObject(def.handoffs)) {
    for (const [source, targets] of Object.entries(def.handoffs)) {
      if (source === agentSlug) return true;
      if (Array.isArray(targets) && targets.includes(agentSlug)) return true;
    }
  }
  return false;
}

// ── Agent CRUD ───────────────────────────────────────────────────────────────

export function listAgents(): AgentView[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM custom_ai_agents ORDER BY id ASC')
    .all() as AgentRow[];
  return rows.map(toAgentView);
}

export function getAgent(id: number): AgentView {
  const db = getDb();
  return toAgentView(getAgentRowOrThrow(db, id));
}

export function getAgentBySlug(slug: string): AgentView | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM custom_ai_agents WHERE slug = ?')
    .get(slug) as AgentRow | undefined;
  return row ? toAgentView(row) : null;
}

export function createAgent(input: AgentInput, actorId: number | null = null): AgentView {
  if (!isPlainObject(input)) {
    throw new OrchestratorValidationError([
      { field: 'agent', message: 'Agent payload must be an object.' },
    ]);
  }

  const issues: FlowValidationIssue[] = [];
  const slug = typeof input.slug === 'string' ? input.slug : '';
  if (!AGENT_SLUG_REGEX.test(slug)) {
    issues.push({
      field: 'slug',
      message: `Agent slug must match ${AGENT_SLUG_REGEX.source}.`,
    });
  }

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) {
    issues.push({ field: 'name', message: 'Agent name is required.' });
  }

  let description = '';
  if (input.description !== undefined) {
    if (typeof input.description !== 'string') {
      issues.push({ field: 'description', message: 'Agent description must be a string.' });
    } else {
      description = input.description;
    }
  }

  const model = typeof input.model === 'string' ? input.model.trim() : '';
  if (!model) {
    issues.push({ field: 'model', message: 'Agent model is required.' });
  }

  let maxOutputTokens: number | null = null;
  if (input.maxOutputTokens !== undefined && input.maxOutputTokens !== null) {
    if (
      typeof input.maxOutputTokens !== 'number' ||
      !Number.isInteger(input.maxOutputTokens) ||
      input.maxOutputTokens <= 0
    ) {
      issues.push({
        field: 'maxOutputTokens',
        message: 'maxOutputTokens must be a positive integer.',
      });
    } else {
      maxOutputTokens = input.maxOutputTokens;
    }
  }

  const knowledgeScope = validateKnowledgeScopePair(
    input.knowledgeScopeKind,
    input.knowledgeScopeId,
    issues,
  );

  let outputPolicyScope: string | null = null;
  if (input.outputPolicyScope !== undefined && input.outputPolicyScope !== null) {
    if (typeof input.outputPolicyScope !== 'string') {
      issues.push({
        field: 'outputPolicyScope',
        message: 'outputPolicyScope must be a string or null.',
      });
    } else {
      const trimmed = input.outputPolicyScope.trim();
      outputPolicyScope = trimmed || null;
    }
  }

  let enabled = true;
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') {
      issues.push({ field: 'enabled', message: 'enabled must be a boolean.' });
    } else {
      enabled = input.enabled;
    }
  }

  if (input.systemPrompt !== undefined && typeof input.systemPrompt !== 'string') {
    issues.push({ field: 'systemPrompt', message: 'systemPrompt must be a string.' });
  }

  if (issues.length > 0) {
    throw new OrchestratorValidationError(issues);
  }

  const db = getDb();
  const existing = db
    .prepare('SELECT id FROM custom_ai_agents WHERE slug = ?')
    .get(slug) as { id: number } | undefined;
  if (existing) {
    throw new OrchestratorConflictError(
      'slug_taken',
      `Agent slug '${slug}' already exists.`,
    );
  }

  const createdId = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO custom_ai_agents
           (slug, name, description, model, knowledge_scope_kind, knowledge_scope_id, output_policy_scope, max_output_tokens, enabled, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(
        slug,
        name,
        description,
        model,
        knowledgeScope.kind,
        knowledgeScope.id,
        outputPolicyScope,
        maxOutputTokens,
        enabled ? 1 : 0,
      );

    const agentId = Number(info.lastInsertRowid);
    db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(
      scopeBindingSettingsKey({ kind: 'agent', id: String(agentId) }),
      JSON.stringify({ enabled: true, maxRounds: null }),
    );

    if (input.systemPrompt !== undefined) {
      saveAndPublishAgentPrompt(agentId, input.systemPrompt, actorId);
    }

    return agentId;
  })();

  return getAgent(createdId);
}

export function updateAgent(
  id: number,
  patch: AgentPatchInput,
  actorId: number | null = null,
): AgentView {
  if (!isPlainObject(patch)) {
    throw new OrchestratorValidationError([
      { field: 'agent', message: 'Agent patch payload must be an object.' },
    ]);
  }
  if (typeof patch.revision !== 'number' || !Number.isInteger(patch.revision)) {
    throw new OrchestratorValidationError([
      { field: 'revision', message: 'revision must be an integer.' },
    ]);
  }

  const db = getDb();
  const row = getAgentRowOrThrow(db, id);
  if (patch.revision !== row.revision) {
    throw new OrchestratorConflictError(
      'revision_conflict',
      'Agent has been modified concurrently; reload the latest state.',
      { current: toAgentView(row) },
    );
  }

  const issues: FlowValidationIssue[] = [];

  let name = row.name;
  if (patch.name !== undefined) {
    if (typeof patch.name !== 'string' || !patch.name.trim()) {
      issues.push({ field: 'name', message: 'Agent name must be a non-empty string.' });
    } else {
      name = patch.name.trim();
    }
  }

  let description = row.description;
  if (patch.description !== undefined) {
    if (typeof patch.description !== 'string') {
      issues.push({ field: 'description', message: 'Agent description must be a string.' });
    } else {
      description = patch.description;
    }
  }

  let model = row.model;
  if (patch.model !== undefined) {
    if (typeof patch.model !== 'string' || !patch.model.trim()) {
      issues.push({ field: 'model', message: 'Agent model must be a non-empty string.' });
    } else {
      model = patch.model.trim();
    }
  }

  let maxOutputTokens = row.max_output_tokens;
  if (patch.maxOutputTokens !== undefined) {
    if (patch.maxOutputTokens === null) {
      maxOutputTokens = null;
    } else if (
      typeof patch.maxOutputTokens !== 'number' ||
      !Number.isInteger(patch.maxOutputTokens) ||
      patch.maxOutputTokens <= 0
    ) {
      issues.push({
        field: 'maxOutputTokens',
        message: 'maxOutputTokens must be a positive integer or null.',
      });
    } else {
      maxOutputTokens = patch.maxOutputTokens;
    }
  }

  let knowledgeScopeKind = row.knowledge_scope_kind;
  let knowledgeScopeId = row.knowledge_scope_id;
  if (patch.knowledgeScopeKind !== undefined || patch.knowledgeScopeId !== undefined) {
    const rawKind =
      patch.knowledgeScopeKind !== undefined ? patch.knowledgeScopeKind : row.knowledge_scope_kind;
    const rawId =
      patch.knowledgeScopeId !== undefined ? patch.knowledgeScopeId : row.knowledge_scope_id;
    const paired = validateKnowledgeScopePair(rawKind, rawId, issues);
    knowledgeScopeKind = paired.kind;
    knowledgeScopeId = paired.id;
  }

  let outputPolicyScope = row.output_policy_scope;
  if (patch.outputPolicyScope !== undefined) {
    if (patch.outputPolicyScope === null) {
      outputPolicyScope = null;
    } else if (typeof patch.outputPolicyScope !== 'string') {
      issues.push({
        field: 'outputPolicyScope',
        message: 'outputPolicyScope must be a string or null.',
      });
    } else {
      outputPolicyScope = patch.outputPolicyScope.trim() || null;
    }
  }

  let enabled = row.enabled === 1;
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') {
      issues.push({ field: 'enabled', message: 'enabled must be a boolean.' });
    } else {
      enabled = patch.enabled;
    }
  }

  if (patch.systemPrompt !== undefined && typeof patch.systemPrompt !== 'string') {
    issues.push({ field: 'systemPrompt', message: 'systemPrompt must be a string.' });
  }

  if (issues.length > 0) {
    throw new OrchestratorValidationError(issues);
  }

  db.transaction(() => {
    const res = db
      .prepare(
        `UPDATE custom_ai_agents
            SET name = ?,
                description = ?,
                model = ?,
                knowledge_scope_kind = ?,
                knowledge_scope_id = ?,
                output_policy_scope = ?,
                max_output_tokens = ?,
                enabled = ?,
                revision = revision + 1
          WHERE id = ? AND revision = ?`,
      )
      .run(
        name,
        description,
        model,
        knowledgeScopeKind,
        knowledgeScopeId,
        outputPolicyScope,
        maxOutputTokens,
        enabled ? 1 : 0,
        id,
        patch.revision,
      );

    if (res.changes !== 1) {
      throw new OrchestratorConflictError(
        'revision_conflict',
        'Agent has been modified concurrently; reload the latest state.',
        { current: getAgent(id) },
      );
    }

    if (patch.systemPrompt !== undefined) {
      saveAndPublishAgentPrompt(id, patch.systemPrompt, actorId);
    }
  })();

  return getAgent(id);
}

export function deleteAgent(id: number): { ok: true } {
  const db = getDb();
  const row = getAgentRowOrThrow(db, id);

  const flowRows = db
    .prepare('SELECT id, slug, name, draft_json, published_json FROM custom_ai_flows ORDER BY id ASC')
    .all() as Array<{
    id: number;
    slug: string;
    name: string;
    draft_json: string;
    published_json: string | null;
  }>;

  const referencingFlows: Array<{ id: number; slug: string; name: string }> = [];
  for (const flow of flowRows) {
    const draft = parseJsonSafe<unknown>(flow.draft_json, null);
    const published = flow.published_json ? parseJsonSafe<unknown>(flow.published_json, null) : null;
    if (flowReferencesAgent(draft, row.slug) || flowReferencesAgent(published, row.slug)) {
      referencingFlows.push({ id: flow.id, slug: flow.slug, name: flow.name });
    }
  }

  if (referencingFlows.length > 0) {
    throw new OrchestratorConflictError(
      'in_use',
      `Agent '${row.slug}' is referenced by one or more flows.`,
      { flows: referencingFlows },
    );
  }

  const scopeId = String(id);
  db.transaction(() => {
    db.prepare('DELETE FROM custom_ai_agents WHERE id = ?').run(id);
    if (hasTable(db, 'custom_ai_prompt_versions')) {
      db.prepare(
        "DELETE FROM custom_ai_prompt_versions WHERE scope_kind = 'agent' AND scope_id = ?",
      ).run(scopeId);
    }
    if (hasTable(db, 'custom_ai_prompt_heads')) {
      db.prepare(
        "DELETE FROM custom_ai_prompt_heads WHERE scope_kind = 'agent' AND scope_id = ?",
      ).run(scopeId);
    }
    if (hasTable(db, 'custom_ai_tool_bindings')) {
      db.prepare(
        "DELETE FROM custom_ai_tool_bindings WHERE scope_kind = 'agent' AND scope_id = ?",
      ).run(scopeId);
    }
    purgeScope('agent', scopeId);
  })();

  return { ok: true };
}

// ── Flow Validation ──────────────────────────────────────────────────────────

function collectSlugIssues(slug: unknown, issues: FlowValidationIssue[]): string {
  if (typeof slug !== 'string' || !FLOW_SLUG_REGEX.test(slug)) {
    issues.push({
      field: 'slug',
      message: `Flow slug must match ${FLOW_SLUG_REGEX.source}.`,
    });
    return '';
  }
  if (RESERVED_FLOW_SLUGS.has(slug)) {
    issues.push({
      field: 'slug',
      message: `Flow slug '${slug}' is reserved.`,
    });
    return '';
  }
  return slug;
}

export function validateFlowSlug(slug: string): void {
  const issues: FlowValidationIssue[] = [];
  collectSlugIssues(slug, issues);
  if (issues.length > 0) {
    throw new OrchestratorValidationError(issues);
  }
}

function collectDraftIssues(
  db: Db,
  draft: unknown,
  issues: FlowValidationIssue[],
): FlowDefinition | null {
  if (!isPlainObject(draft)) {
    issues.push({ field: 'draft', message: 'Flow definition must be an object.' });
    return null;
  }

  const kind = draft.kind;
  if (kind !== 'single' && kind !== 'handoff') {
    issues.push({ field: 'kind', message: "Flow kind must be 'single' or 'handoff'." });
  }

  const agents: string[] = [];
  const agentsSet = new Set<string>();
  if (!Array.isArray(draft.agents) || draft.agents.length === 0) {
    issues.push({ field: 'agents', message: 'Flow must include at least one agent.' });
  } else {
    for (const item of draft.agents) {
      if (typeof item !== 'string' || !item.trim()) {
        issues.push({ field: 'agents', message: 'Each flow agent must be a non-empty slug.' });
        continue;
      }
      if (agentsSet.has(item)) {
        issues.push({ field: 'agents', message: `Duplicate agent slug '${item}' in flow.` });
        continue;
      }
      agentsSet.add(item);
      agents.push(item);
    }

    if (agents.length > 0) {
      const placeholders = agents.map(() => '?').join(', ');
      const foundRows = db
        .prepare(`SELECT slug, enabled FROM custom_ai_agents WHERE slug IN (${placeholders})`)
        .all(...agents) as Array<{ slug: string; enabled: number }>;
      const bySlug = new Map(foundRows.map((r) => [r.slug, r]));
      for (const slug of agents) {
        const found = bySlug.get(slug);
        if (!found) {
          issues.push({ field: 'agents', message: `Agent '${slug}' does not exist.` });
        } else if (found.enabled !== 1) {
          issues.push({ field: 'agents', message: `Agent '${slug}' is disabled.` });
        }
      }
    }
  }

  const entryAgent = typeof draft.entryAgent === 'string' ? draft.entryAgent : '';
  if (!entryAgent) {
    issues.push({ field: 'entryAgent', message: 'entryAgent is required.' });
  } else if (!agentsSet.has(entryAgent)) {
    issues.push({
      field: 'entryAgent',
      message: `entryAgent '${entryAgent}' must be included in flow agents.`,
    });
  }

  const handoffs: Record<string, string[]> = {};
  if (!isPlainObject(draft.handoffs)) {
    issues.push({
      field: 'handoffs',
      message: 'handoffs must be an object mapping agent slugs to target arrays.',
    });
  } else {
    for (const [source, rawTargets] of Object.entries(draft.handoffs)) {
      if (!agentsSet.has(source)) {
        issues.push({
          field: `handoffs.${source}`,
          message: `Handoff source '${source}' must be included in flow agents.`,
        });
        continue;
      }
      if (!Array.isArray(rawTargets)) {
        issues.push({
          field: `handoffs.${source}`,
          message: `Handoff targets for '${source}' must be an array.`,
        });
        continue;
      }
      if (kind === 'single' && rawTargets.length > 0) {
        issues.push({
          field: `handoffs.${source}`,
          message: `Single-agent flows cannot define handoff targets for '${source}'.`,
        });
      }
      const cleanTargets: string[] = [];
      const seenTargets = new Set<string>();
      for (const target of rawTargets) {
        if (typeof target !== 'string' || !agentsSet.has(target)) {
          issues.push({
            field: `handoffs.${source}`,
            message: `Handoff target '${String(target)}' must be included in flow agents.`,
          });
          continue;
        }
        if (target === source) {
          issues.push({
            field: `handoffs.${source}`,
            message: `Agent '${source}' cannot hand off to itself.`,
          });
          continue;
        }
        if (!seenTargets.has(target)) {
          seenTargets.add(target);
          cleanTargets.push(target);
        }
      }
      handoffs[source] = cleanTargets;
    }
  }

  const limitSpecs: Array<{
    key: keyof FlowLimitsConfig;
    hardMax: number;
  }> = [
    { key: 'maxSteps', hardMax: FLOW_LIMITS.hardMaxSteps },
    { key: 'maxToolCalls', hardMax: FLOW_LIMITS.hardMaxToolCalls },
    { key: 'maxHandoffs', hardMax: FLOW_LIMITS.hardMaxHandoffs },
    { key: 'maxTokens', hardMax: FLOW_LIMITS.hardMaxTokens },
    { key: 'maxSeconds', hardMax: FLOW_LIMITS.hardMaxSeconds },
  ];

  const limits: FlowLimitsConfig = {
    maxSteps: FLOW_LIMITS.defaultMaxSteps,
    maxToolCalls: FLOW_LIMITS.defaultMaxToolCalls,
    maxHandoffs: FLOW_LIMITS.defaultMaxHandoffs,
    maxTokens: FLOW_LIMITS.defaultMaxTokens,
    maxSeconds: FLOW_LIMITS.defaultMaxSeconds,
  };

  if (!isPlainObject(draft.limits)) {
    issues.push({ field: 'limits', message: 'limits configuration object is required.' });
  } else {
    for (const { key, hardMax } of limitSpecs) {
      const value = draft.limits[key];
      if (
        typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < 1 ||
        value > hardMax
      ) {
        issues.push({
          field: `limits.${key}`,
          message: `${key} must be an integer between 1 and ${hardMax}.`,
        });
      } else {
        limits[key] = value;
      }
    }
  }

  let approvalTtlHours: number = FLOW_LIMITS.defaultApprovalTtlHours;
  if (draft.approvalTtlHours !== undefined) {
    if (
      typeof draft.approvalTtlHours !== 'number' ||
      !Number.isInteger(draft.approvalTtlHours) ||
      draft.approvalTtlHours < 1 ||
      draft.approvalTtlHours > FLOW_LIMITS.maxApprovalTtlHours
    ) {
      issues.push({
        field: 'approvalTtlHours',
        message: `approvalTtlHours must be an integer between 1 and ${FLOW_LIMITS.maxApprovalTtlHours}.`,
      });
    } else {
      approvalTtlHours = draft.approvalTtlHours;
    }
  }

  let awaitingApprovalText: string = FLOW_LIMITS.defaultAwaitingApprovalText;
  if (draft.awaitingApprovalText !== undefined) {
    if (typeof draft.awaitingApprovalText !== 'string') {
      issues.push({
        field: 'awaitingApprovalText',
        message: 'awaitingApprovalText must be a string.',
      });
    } else if (draft.awaitingApprovalText.length > 2_000) {
      issues.push({
        field: 'awaitingApprovalText',
        message: 'awaitingApprovalText must be at most 2000 characters.',
      });
    } else {
      awaitingApprovalText = draft.awaitingApprovalText;
    }
  }

  if (issues.length > 0) {
    return null;
  }

  return {
    kind: kind as FlowDefinition['kind'],
    entryAgent,
    agents,
    handoffs,
    limits,
    awaitingApprovalText,
    approvalTtlHours,
  };
}

export function validateFlowDraftDefinition(draft: FlowDefinition): FlowDefinition {
  const db = getDb();
  const issues: FlowValidationIssue[] = [];
  const normalized = collectDraftIssues(db, draft, issues);
  if (issues.length > 0 || !normalized) {
    throw new OrchestratorValidationError(issues);
  }
  return normalized;
}

// ── Flow CRUD, Publishing & Grants ───────────────────────────────────────────

export function listFlows(): FlowView[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM custom_ai_flows ORDER BY id ASC')
    .all() as FlowRow[];
  return rows.map(toFlowView);
}

export function getFlow(id: number): FlowView {
  const db = getDb();
  return toFlowView(getFlowRowOrThrow(db, id));
}

export function getFlowDetail(id: number): FlowDetailView {
  const db = getDb();
  const flow = toFlowView(getFlowRowOrThrow(db, id));
  const grantRows = db
    .prepare('SELECT profile_id FROM custom_ai_flow_grants WHERE flow_id = ? ORDER BY profile_id ASC')
    .all(id) as Array<{ profile_id: number }>;
  return {
    flow,
    grantedProfileIds: grantRows.map((r) => r.profile_id),
  };
}

export function getFlowBySlug(slug: string): FlowView | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM custom_ai_flows WHERE slug = ?')
    .get(slug) as FlowRow | undefined;
  return row ? toFlowView(row) : null;
}

export function createFlow(input: FlowCreateInput): FlowView {
  if (!isPlainObject(input)) {
    throw new OrchestratorValidationError([
      { field: 'flow', message: 'Flow payload must be an object.' },
    ]);
  }

  const db = getDb();
  const issues: FlowValidationIssue[] = [];
  const slug = collectSlugIssues(input.slug, issues);

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) {
    issues.push({ field: 'name', message: 'Flow name is required.' });
  }

  let description = '';
  if (input.description !== undefined) {
    if (typeof input.description !== 'string') {
      issues.push({ field: 'description', message: 'Flow description must be a string.' });
    } else {
      description = input.description;
    }
  }

  let enabled = true;
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') {
      issues.push({ field: 'enabled', message: 'enabled must be a boolean.' });
    } else {
      enabled = input.enabled;
    }
  }

  const normalizedDraft = collectDraftIssues(db, input.draft, issues);
  if (issues.length > 0 || !normalizedDraft) {
    throw new OrchestratorValidationError(issues);
  }

  const existing = db
    .prepare('SELECT id FROM custom_ai_flows WHERE slug = ?')
    .get(slug) as { id: number } | undefined;
  if (existing) {
    throw new OrchestratorConflictError(
      'slug_taken',
      `Flow slug '${slug}' already exists.`,
    );
  }

  const info = db
    .prepare(
      `INSERT INTO custom_ai_flows
         (slug, name, description, draft_json, published_json, published_version, enabled, revision)
       VALUES (?, ?, ?, ?, NULL, 0, ?, 1)`,
    )
    .run(slug, name, description, JSON.stringify(normalizedDraft), enabled ? 1 : 0);

  return getFlow(Number(info.lastInsertRowid));
}

export function updateFlowDraft(id: number, input: FlowDraftInput): FlowView {
  if (!isPlainObject(input)) {
    throw new OrchestratorValidationError([
      { field: 'flow', message: 'Flow draft payload must be an object.' },
    ]);
  }
  if (typeof input.revision !== 'number' || !Number.isInteger(input.revision)) {
    throw new OrchestratorValidationError([
      { field: 'revision', message: 'revision must be an integer.' },
    ]);
  }

  const db = getDb();
  const row = getFlowRowOrThrow(db, id);
  if (input.revision !== row.revision) {
    throw new OrchestratorConflictError(
      'revision_conflict',
      'Flow has been modified concurrently; reload the latest state.',
      { current: getFlowDetail(id) },
    );
  }

  const issues: FlowValidationIssue[] = [];

  let name = row.name;
  if (input.name !== undefined) {
    if (typeof input.name !== 'string' || !input.name.trim()) {
      issues.push({ field: 'name', message: 'Flow name must be a non-empty string.' });
    } else {
      name = input.name.trim();
    }
  }

  let description = row.description;
  if (input.description !== undefined) {
    if (typeof input.description !== 'string') {
      issues.push({ field: 'description', message: 'Flow description must be a string.' });
    } else {
      description = input.description;
    }
  }

  let enabled = row.enabled === 1;
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') {
      issues.push({ field: 'enabled', message: 'enabled must be a boolean.' });
    } else {
      enabled = input.enabled;
    }
  }

  const normalizedDraft = collectDraftIssues(db, input.draft, issues);
  if (issues.length > 0 || !normalizedDraft) {
    throw new OrchestratorValidationError(issues);
  }

  const res = db
    .prepare(
      `UPDATE custom_ai_flows
          SET name = ?,
              description = ?,
              enabled = ?,
              draft_json = ?,
              revision = revision + 1
        WHERE id = ? AND revision = ?`,
    )
    .run(
      name,
      description,
      enabled ? 1 : 0,
      JSON.stringify(normalizedDraft),
      id,
      input.revision,
    );

  if (res.changes !== 1) {
    throw new OrchestratorConflictError(
      'revision_conflict',
      'Flow has been modified concurrently; reload the latest state.',
      { current: getFlowDetail(id) },
    );
  }

  return getFlow(id);
}

export function publishFlow(
  id: number,
  revision: number,
  _actorId: number | null = null,
): FlowView {
  if (typeof revision !== 'number' || !Number.isInteger(revision)) {
    throw new OrchestratorValidationError([
      { field: 'revision', message: 'revision must be an integer.' },
    ]);
  }

  const db = getDb();
  const row = getFlowRowOrThrow(db, id);
  if (revision !== row.revision) {
    throw new OrchestratorConflictError(
      'revision_conflict',
      'Flow has been modified concurrently; reload the latest state.',
      { current: getFlowDetail(id) },
    );
  }

  const draftRaw = parseJsonSafe<unknown>(row.draft_json, null);
  const issues: FlowValidationIssue[] = [];
  const validatedDraft = collectDraftIssues(db, draftRaw, issues);
  if (issues.length > 0 || !validatedDraft) {
    throw new OrchestratorValidationError(issues);
  }

  const placeholders = validatedDraft.agents.map(() => '?').join(', ');
  const agentRows = db
    .prepare(`SELECT * FROM custom_ai_agents WHERE slug IN (${placeholders})`)
    .all(...validatedDraft.agents) as AgentRow[];
  const agentBySlug = new Map(agentRows.map((a) => [a.slug, a]));

  const agentPromptVersions: Record<string, number | null> = {};
  const agentSnapshots: Record<string, PublishedAgentSnapshot> = {};

  for (const agentSlug of validatedDraft.agents) {
    const agent = agentBySlug.get(agentSlug);
    if (!agent) {
      throw new OrchestratorValidationError([
        { field: 'agents', message: `Agent '${agentSlug}' does not exist.` },
      ]);
    }
    const publishedPrompt = getPublishedPrompt({ kind: 'agent', id: String(agent.id) });
    const promptVersion = publishedPrompt ? publishedPrompt.version : null;
    agentPromptVersions[agentSlug] = promptVersion;
    agentSnapshots[agentSlug] = {
      agentId: agent.id,
      slug: agent.slug,
      name: agent.name,
      model: agent.model,
      promptVersion,
      promptBody: publishedPrompt ? publishedPrompt.body : '',
      promptVariables: publishedPrompt ? publishedPrompt.variables : [],
      knowledgeScopeKind: agent.knowledge_scope_kind ?? null,
      knowledgeScopeId: agent.knowledge_scope_id ?? null,
      outputPolicyScope: agent.output_policy_scope ?? null,
      maxOutputTokens: agent.max_output_tokens ?? null,
    };
  }

  const publishedDef: PublishedFlowDefinition = {
    ...validatedDraft,
    agentPromptVersions,
    agentSnapshots,
  };

  db.transaction(() => {
    const res = db
      .prepare(
        `UPDATE custom_ai_flows
            SET published_json = ?,
                published_version = published_version + 1,
                revision = revision + 1
          WHERE id = ? AND revision = ?`,
      )
      .run(JSON.stringify(publishedDef), id, revision);
    if (res.changes !== 1) {
      throw new OrchestratorConflictError(
        'revision_conflict',
        'Flow has been modified concurrently; reload the latest state.',
        { current: getFlowDetail(id) },
      );
    }
  })();

  return getFlow(id);
}

export function deleteFlow(id: number): { ok: true } {
  const db = getDb();
  getFlowRowOrThrow(db, id);
  db.transaction(() => {
    db.prepare('DELETE FROM custom_ai_flow_grants WHERE flow_id = ?').run(id);
    db.prepare('DELETE FROM custom_ai_flows WHERE id = ?').run(id);
  })();
  return { ok: true };
}

export function setFlowGrants(id: number, profileIds: number[]): FlowDetailView {
  if (!Array.isArray(profileIds)) {
    throw new OrchestratorValidationError([
      { field: 'profileIds', message: 'profileIds must be an array of integers.' },
    ]);
  }

  const uniqueProfileIds: number[] = [];
  const seen = new Set<number>();
  for (const pid of profileIds) {
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
      throw new OrchestratorValidationError([
        { field: 'profileIds', message: 'profileIds must contain positive integers.' },
      ]);
    }
    if (!seen.has(pid)) {
      seen.add(pid);
      uniqueProfileIds.push(pid);
    }
  }

  const db = getDb();
  getFlowRowOrThrow(db, id);

  if (uniqueProfileIds.length > 0) {
    const placeholders = uniqueProfileIds.map(() => '?').join(', ');
    const found = db
      .prepare(`SELECT id FROM client_profiles WHERE id IN (${placeholders})`)
      .all(...uniqueProfileIds) as Array<{ id: number }>;
    if (found.length !== uniqueProfileIds.length) {
      const foundSet = new Set(found.map((r) => r.id));
      const missing = uniqueProfileIds.filter((pid) => !foundSet.has(pid));
      throw new OrchestratorNotFoundError(
        `Client profile(s) not found: ${missing.join(', ')}.`,
        'profile_not_found',
      );
    }
  }

  db.transaction(() => {
    db.prepare('DELETE FROM custom_ai_flow_grants WHERE flow_id = ?').run(id);
    const insert = db.prepare(
      'INSERT INTO custom_ai_flow_grants (flow_id, profile_id) VALUES (?, ?)',
    );
    for (const pid of uniqueProfileIds) {
      insert.run(id, pid);
    }
  })();

  return getFlowDetail(id);
}

export function listGrantedFlowsForProfile(profileId: number): FlowView[] {
  if (!Number.isInteger(profileId) || profileId <= 0) return [];
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT f.*
         FROM custom_ai_flows f
         JOIN custom_ai_flow_grants g ON g.flow_id = f.id
        WHERE g.profile_id = ?
          AND f.enabled = 1
          AND f.published_json IS NOT NULL
        ORDER BY f.id ASC`,
    )
    .all(profileId) as FlowRow[];
  return rows.map(toFlowView);
}

export function isFlowGrantedToProfile(flowId: number, profileId: number): boolean {
  if (!Number.isInteger(flowId) || flowId <= 0) return false;
  if (!Number.isInteger(profileId) || profileId <= 0) return false;
  const db = getDb();
  const row = db
    .prepare('SELECT 1 FROM custom_ai_flow_grants WHERE flow_id = ? AND profile_id = ?')
    .get(flowId, profileId);
  return Boolean(row);
}
