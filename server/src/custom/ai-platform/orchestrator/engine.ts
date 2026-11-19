import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import type { Scope, ScopeKind, Wire } from '@freellmapi/shared/ai-platform.js';
import type {
  BoundTool,
  ChatMessage,
  ChatToolCall,
  ChatToolDefinition,
  TokenUsage,
  ToolContext,
  ToolExecutionResult,
} from '@freellmapi/shared/ai-platform-mcp.js';
import type { GuardEvaluateResult } from '@freellmapi/shared/ai-platform-output-guard.js';
import type { PromptVariable } from '@freellmapi/shared/ai-platform-prompts.js';
import type { RetrievalQueryResponse } from '@freellmapi/shared/ai-platform-retrieval.js';
import {
  FLOW_LIMITS,
  FLOW_SLUG_REGEX,
  type FlowDefinition,
  type FlowRunStatus,
  type FlowRunView,
  type FlowStepKind,
  type FlowStopReason,
  type PublishedAgentSnapshot,
  type PublishedFlowDefinition,
} from '@freellmapi/shared/ai-platform-orchestrator.js';
import { getDb, getInternalLoopbackToken } from '../../../db/index.js';
import { decrypt } from '../../../lib/crypto.js';
import { extractInferenceToken } from '../../../middleware/user-rate-limit.js';
import { compactLoopMessagesForBudget } from '../../context-budget/loop-guard.js';
import { isPillarEnabled } from '../flags.js';
import { callGateway, GatewayCallError, type LoopbackRequest } from '../loopback.js';
import { maskText } from '../masking.js';
import { toolsForScope } from '../mcp-client/bindings.js';
import { toLoopbackMessages } from '../mcp-client/messages.js';
import { executeTool } from '../mcp-client/tools.js';
import type { GuardEvalContext } from '../output-guard/policy.js';
import { extractCallerLanguage, extractEndUserName, parseCallerVarsHeader } from '../prompts/render.js';
import { getPublishedPrompt } from '../prompts/store.js';
import { renderWith, sanitizeVariableValue } from '../prompts/template.js';
import { retrieve, type RetrieveOptions } from '../retrieval/hybrid.js';
import { sendText } from '../wire/respond.js';
import { requestedModel as wireRequestedModel } from '../wire/extract.js';
import { getAgentBySlug, getFlow, getFlowBySlug } from './definitions.js';
import { FlowRunLimiter, type LimiterSnapshot } from './limits.js';
import {
  appendRunStep,
  createRunRecord,
  finishRunRecord,
  getRunRecord,
  markRunRunning,
  pauseRunForApproval,
  updateRunProgress,
} from './trace.js';

export interface OrchestratorEngineDeps {
  callGateway?: (
    req: Request,
    body: LoopbackRequest,
  ) => Promise<{ message: ChatMessage; finishReason: string; usage: TokenUsage; servedModel: string }>;
  toolsForScope?: (scope: Scope, callerTools?: ChatToolDefinition[]) => BoundTool[];
  executeTool?: (ctx: ToolContext, tool: BoundTool, args: unknown) => Promise<ToolExecutionResult>;
  retrieve?: (scope: Scope, query: string, opts?: RetrieveOptions) => Promise<RetrievalQueryResponse>;
  evaluateOutput?: (scope: Scope, text: string, ctx: GuardEvalContext) => Promise<GuardEvaluateResult>;
}

export interface FlowExecutionResult {
  run: FlowRunView;
  outputText: string;
  finishReason: 'stop' | 'content_filter';
  usage: TokenUsage;
  guardHeader?: string;
}

export interface StartRunInput {
  runId?: string;
  flowSlug?: string;
  flowId?: number;
  profileId: number;
  endUser: string | null;
  wire: Wire;
  messages: ChatMessage[];
  isDryRun?: boolean;
  stream?: boolean;
  req?: Request;
  res?: Response;
  signal?: AbortSignal;
  deps?: OrchestratorEngineDeps;
}

export interface ResumeApprovalInput {
  id: number;
  approved: boolean;
  note?: string;
}

interface CallerContextSnapshot {
  profileName: string;
  endUserName: string;
  language: string;
  callerVars: Record<string, string>;
}

interface RunContinuationState {
  version: 1;
  approvalId: number;
  pendingToolCall: ChatToolCall;
  remainingToolCalls: ChatToolCall[];
  pausedAgentSlug: string;
  agentConversation: ChatMessage[];
  userMessages: ChatMessage[];
  userQuery: string;
  callerContext: CallerContextSnapshot;
  limiterSnapshot: LimiterSnapshot;
  bestTextSoFar: string;
  publishedFlow: PublishedFlowDefinition;
  flowId: number;
  flowSlug: string;
  flowVersion: number;
  isDryRun: boolean;
}

interface ResolvedAgentRuntime {
  agentId: number;
  slug: string;
  name: string;
  model: string;
  promptBody: string;
  promptVariables: PromptVariable[];
  knowledgeScopeKind: ScopeKind | null;
  knowledgeScopeId: string | null;
  outputPolicyScope: string | null;
  maxOutputTokens: number | null;
}

const activeRunControllers = new Map<string, AbortController>();
let lastServerAddress: { localAddress: string; localPort: number } = {
  localAddress: '127.0.0.1',
  localPort: 80,
};

/** Records the HTTP server socket address from inbound requests for later async resume loopbacks. */
export function recordServerLocalAddress(req: Request): void {
  const port = req.socket?.localPort;
  if (typeof port === 'number' && Number.isInteger(port) && port > 0) {
    const rawAddr = req.socket?.localAddress ?? '127.0.0.1';
    const localAddress =
      rawAddr.includes(':') && !rawAddr.startsWith('::ffff:') ? '::1' : '127.0.0.1';
    lastServerAddress = { localAddress, localPort: port };
  }
}

export function getServerSocketAddressForLoopback(req?: Request): { localAddress: string; localPort: number } {
  return getRecordedServerAddress(req);
}

export function getRecordedServerAddress(req?: Request): { localAddress: string; localPort: number } {
  const port = req?.socket?.localPort;
  if (typeof port === 'number' && Number.isInteger(port) && port > 0) {
    const rawAddr = req?.socket?.localAddress ?? '127.0.0.1';
    const localAddress =
      rawAddr.includes(':') && !rawAddr.startsWith('::ffff:') ? '::1' : '127.0.0.1';
    return { localAddress, localPort: port };
  }
  return lastServerAddress;
}

const GEMINI_FLOW_PATH_RE = /^\/v1beta\/models\/(.+?):(?:stream)?generatecontent$/i;

/**
 * Extracts the requested model id from any of the 4 supported wire protocols,
 * supporting `flow:<slug>` models with colons on Gemini `/v1beta/models/flow:<slug>:generateContent`.
 */
export function extractRequestedModel(wire: Wire, req: Request): string {
  if (wire === 'gemini') {
    const raw = (req.originalUrl || req.url || req.path || '').split('?')[0]!;
    const match = GEMINI_FLOW_PATH_RE.exec(raw);
    if (match?.[1]) {
      try {
        return decodeURIComponent(match[1]).replace(/^models\//, '');
      } catch {
        return match[1].replace(/^models\//, '');
      }
    }
  }
  return wireRequestedModel(wire, req);
}

/**
 * Extracts and validates the slug from a `flow:<slug>` model identifier.
 * Returns `null` if the string does not have a `flow:` prefix or fails `FLOW_SLUG_REGEX`.
 */
export function isFlowModel(model: string): string | null {
  if (typeof model !== 'string') return null;
  const trimmed = model.trim();
  if (!trimmed.startsWith('flow:')) return null;
  const slug = trimmed.slice(5);
  return FLOW_SLUG_REGEX.test(slug) ? slug : null;
}

function isGeminiJsonArrayStream(res: Response, wire?: Wire): boolean {
  if (wire !== 'gemini') return false;
  const req = (res as { req?: { query?: Record<string, unknown>; originalUrl?: string } }).req;
  if (!req) return false;
  const alt = typeof req.query?.alt === 'string' ? req.query.alt.toLowerCase() : '';
  if (alt === 'sse') return false;
  if (typeof req.originalUrl === 'string' && /[?&]alt=sse(?:&|$)/i.test(req.originalUrl)) return false;
  return true;
}

function isLiveSseActive(res?: Response, stream?: boolean, wire?: Wire): res is Response {
  if (!res || !stream) return false;
  if (isGeminiJsonArrayStream(res, wire)) return false;
  return true;
}

function emitSseProgress(
  res: Response | undefined,
  stream: boolean,
  wire: Wire,
  runId: string,
  step: number,
  agent: string,
  kind: FlowStepKind,
): void {
  if (!isLiveSseActive(res, stream, wire)) return;
  if (res.writableEnded || res.destroyed) return;
  try {
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('x-freellm-run-id', runId);
      res.setHeader('x-freellm-run-status', 'running');
    }
    res.write(`: progress ${JSON.stringify({ step, agent, kind })}\n\n`);
  } catch {
    // Client may have closed socket mid-stream.
  }
}

/**
 * Wraps `Response` so `sendText` never throws `ERR_HTTP_HEADERS_SENT` if SSE headers
 * were already flushed by `: progress` comments.
 */
function safeResponseForSendText(res: Response): Response {
  if (!res.headersSent) return res;
  return new Proxy(res, {
    get(target, prop, receiver) {
      if (prop === 'setHeader') {
        return (name: string, value: number | string | readonly string[]) => {
          if (!target.headersSent) {
            return target.setHeader(name, value);
          }
          return target;
        };
      }
      if (prop === 'status') {
        return (code: number) => {
          if (!target.headersSent) {
            return target.status(code);
          }
          return target;
        };
      }
      const val = Reflect.get(target, prop, receiver);
      return typeof val === 'function' ? val.bind(target) : val;
    },
  });
}

function lookupProfileName(profileId: number): string {
  if (profileId <= 0) return 'dry-run';
  try {
    const row = getDb()
      .prepare('SELECT name FROM client_profiles WHERE id = ?')
      .get(profileId) as { name?: string } | undefined;
    return typeof row?.name === 'string' ? sanitizeVariableValue(row.name.trim()) : '';
  } catch {
    return '';
  }
}

function captureCallerContext(req: Request | undefined, profileId: number): CallerContextSnapshot {
  if (!req) {
    return {
      profileName: lookupProfileName(profileId),
      endUserName: '',
      language: '',
      callerVars: {},
    };
  }
  return {
    profileName: lookupProfileName(profileId),
    endUserName: extractEndUserName(req),
    language: extractCallerLanguage(req),
    callerVars: parseCallerVarsHeader(req.headers['x-freellm-vars']),
  };
}

function buildSyntheticLoopbackReq(
  profileId: number,
  endUser: string | null,
  inboundReq?: Request,
): Request {
  let token = '';
  if (profileId === 0) {
    token = getInternalLoopbackToken();
  } else {
    try {
      const row = getDb()
        .prepare('SELECT encrypted_key, iv, auth_tag FROM client_profiles WHERE id = ?')
        .get(profileId) as { encrypted_key: string; iv: string; auth_tag: string } | undefined;
      if (row?.encrypted_key && row.iv && row.auth_tag) {
        token = decrypt(row.encrypted_key, row.iv, row.auth_tag);
      }
    } catch {
      // Fallback below if row was a unit-test stub without valid ciphertext
    }
    if (!token && inboundReq) {
      const candidate = extractInferenceToken(inboundReq);
      if (candidate?.startsWith('sk-cp-')) {
        token = candidate;
      }
    }
  }
  const addr = getRecordedServerAddress(inboundReq);
  return {
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(endUser ? { 'x-end-user': endUser } : {}),
    },
    originalUrl: '/v1/chat/completions',
    url: '/v1/chat/completions',
    path: '/v1/chat/completions',
    query: {},
    body: {},
    socket: {
      localAddress: addr.localAddress,
      localPort: addr.localPort,
    },
  } as unknown as Request;
}

function extractTextFromContent(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
        return part.text;
      }
      return '';
    })
    .filter(Boolean)
    .join('');
}

function extractLatestUserQuery(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role === 'user') {
      return extractTextFromContent(m.content).trim();
    }
  }
  return '';
}

function parseJsonObject(raw: string): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseToolArgs(raw: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (!raw || !raw.trim()) return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'Tool arguments must be a JSON object.' };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, error: 'Invalid JSON tool arguments.' };
  }
}

function parseOutputPolicyScope(raw: string | null | undefined, fallbackProfileId: number): Scope {
  if (typeof raw === 'string' && raw.trim()) {
    const trimmed = raw.trim();
    const sep = trimmed.includes(':') ? ':' : trimmed.includes('/') ? '/' : null;
    if (sep) {
      const idx = trimmed.indexOf(sep);
      const kindRaw = trimmed.slice(0, idx);
      const idRaw = trimmed.slice(idx + 1).trim();
      const kind: ScopeKind | null =
        kindRaw === 'profile'
          ? 'profile'
          : kindRaw === 'support_tenant' || kindRaw === 'support-tenant'
            ? 'support_tenant'
            : null;
      if (kind && /^\d+$/.test(idRaw) && Number(idRaw) > 0) {
        return { kind, id: String(Number(idRaw)) };
      }
    }
  }
  return { kind: 'profile', id: String(fallbackProfileId) };
}

function resolveAgentRuntime(
  slug: string,
  publishedFlow: PublishedFlowDefinition,
  isDryRun: boolean,
): ResolvedAgentRuntime {
  const snap: PublishedAgentSnapshot | undefined = !isDryRun
    ? publishedFlow.agentSnapshots?.[slug]
    : undefined;
  if (snap) {
    return {
      agentId: snap.agentId,
      slug: snap.slug,
      name: snap.name,
      model: snap.model,
      promptBody: snap.promptBody,
      promptVariables: snap.promptVariables,
      knowledgeScopeKind: snap.knowledgeScopeKind,
      knowledgeScopeId: snap.knowledgeScopeId,
      outputPolicyScope: snap.outputPolicyScope,
      maxOutputTokens: snap.maxOutputTokens,
    };
  }

  const agent = getAgentBySlug(slug);
  if (!agent) {
    throw new Error(`Agent '${slug}' not found.`);
  }
  if (!isDryRun && !agent.enabled) {
    throw new Error(`Agent '${slug}' is disabled.`);
  }

  let promptBody = agent.systemPrompt ?? '';
  let promptVariables: PromptVariable[] = [];
  try {
    const pub = getPublishedPrompt({ kind: 'agent', id: String(agent.id) });
    if (pub) {
      promptBody = pub.body;
      promptVariables = pub.variables;
    }
  } catch {
    // Prompt store optional if agent has inline/empty prompt
  }

  return {
    agentId: agent.id,
    slug: agent.slug,
    name: agent.name,
    model: agent.model,
    promptBody,
    promptVariables,
    knowledgeScopeKind: agent.knowledgeScopeKind,
    knowledgeScopeId: agent.knowledgeScopeId,
    outputPolicyScope: agent.outputPolicyScope,
    maxOutputTokens: agent.maxOutputTokens,
  };
}

function renderAgentPrompt(
  agent: ResolvedAgentRuntime,
  callerContext: CallerContextSnapshot,
  endUser: string | null,
): string {
  const raw = agent.promptBody ?? '';
  if (!raw || !raw.includes('{{')) return raw;
  const values: Record<string, string> = {
    date: new Date().toISOString().slice(0, 10),
  };
  if (callerContext.profileName) values.profile_name = callerContext.profileName;
  if (endUser) values.end_user_id = sanitizeVariableValue(endUser);
  if (callerContext.endUserName) values.end_user_name = callerContext.endUserName;
  if (callerContext.language) values.language = callerContext.language;
  for (const v of agent.promptVariables) {
    if (v.source !== 'caller') continue;
    const val = callerContext.callerVars[v.name];
    if (typeof val === 'string' && val.length > 0) {
      values[v.name] = val;
    }
  }
  return renderWith(raw, values, agent.promptVariables).rendered;
}

function boundToolToDefinition(tool: BoundTool): ChatToolDefinition {
  return {
    type: 'function',
    function: {
      name: tool.exposedName,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.inputSchema,
    },
  };
}

function buildHandoffTools(flow: FlowDefinition, agentSlug: string): ChatToolDefinition[] {
  if (flow.kind !== 'handoff') return [];
  const targets = flow.handoffs[agentSlug] ?? [];
  return targets.map((target) => ({
    type: 'function',
    function: {
      name: `transfer_to_${target}`,
      description: `Hand off the conversation to agent '${target}'.`,
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'Short masked summary or reason for transferring to this agent.',
          },
        },
      },
    },
  }));
}

async function buildIsolatedAgentContext(params: {
  agent: ResolvedAgentRuntime;
  flow: PublishedFlowDefinition;
  userMessages: ChatMessage[];
  userQuery: string;
  callerContext: CallerContextSnapshot;
  endUser: string | null;
  handoffFrom?: string;
  handoffReason?: string;
  signal: AbortSignal;
  deps: Required<OrchestratorEngineDeps>;
}): Promise<{
  conversation: ChatMessage[];
  renderedPrompt: string;
  mcpByExposedName: Map<string, BoundTool>;
  tools: ChatToolDefinition[];
}> {
  const { agent, flow, userMessages, userQuery, callerContext, endUser, handoffFrom, handoffReason, signal, deps } =
    params;

  const renderedPrompt = renderAgentPrompt(agent, callerContext, endUser);
  const systemSections: string[] = [];
  if (renderedPrompt.trim()) {
    systemSections.push(renderedPrompt.trim());
  }

  if (agent.knowledgeScopeKind && agent.knowledgeScopeId && userQuery.trim()) {
    try {
      const retrievalRes = await deps.retrieve(
        { kind: agent.knowledgeScopeKind, id: agent.knowledgeScopeId },
        userQuery,
        {
          ...(agent.knowledgeScopeKind === 'support_tenant' ? { roles: [] } : {}),
          signal,
          respectPillarFlag: true,
        },
      );
      if (retrievalRes.hits.length > 0) {
        const blocks = retrievalRes.hits.map((h) => `### ${h.title}\n${h.text}`).join('\n\n');
        systemSections.push(`<reference_data>\n${blocks}\n</reference_data>`);
      }
    } catch {
      // Graceful fallback when retrieval fails
    }
  }

  if (handoffFrom && handoffReason && handoffReason.trim()) {
    systemSections.push(
      `<handoff_context from="${handoffFrom}">\n${handoffReason.trim()}\n</handoff_context>`,
    );
  }

  const conversation: ChatMessage[] = [];
  if (systemSections.length > 0) {
    conversation.push({ role: 'system', content: systemSections.join('\n\n') });
  }
  for (const msg of userMessages) {
    conversation.push({ ...msg });
  }

  const agentScope: Scope = { kind: 'agent', id: String(agent.agentId) };
  let boundTools: BoundTool[] = [];
  try {
    boundTools = deps.toolsForScope(agentScope);
  } catch {
    boundTools = [];
  }

  const mcpByExposedName = new Map<string, BoundTool>(boundTools.map((t) => [t.exposedName, t]));
  const handoffTools = buildHandoffTools(flow, agent.slug);
  const tools: ChatToolDefinition[] = [...boundTools.map(boundToolToDefinition), ...handoffTools];

  return { conversation, renderedPrompt, mcpByExposedName, tools };
}

function getRunStatusInDb(runId: string): FlowRunStatus | null {
  try {
    const row = getDb()
      .prepare('SELECT status FROM custom_ai_runs WHERE id = ?')
      .get(runId) as { status: FlowRunStatus } | undefined;
    return row?.status ?? null;
  } catch {
    return null;
  }
}

async function defaultEvaluateOutput(
  scope: Scope,
  text: string,
  ctx: GuardEvalContext,
): Promise<GuardEvaluateResult> {
  const mod = await import('../output-guard/policy.js');
  return mod.evaluateOutput(scope, text, ctx);
}

function resolveDeps(deps?: OrchestratorEngineDeps): Required<OrchestratorEngineDeps> {
  return {
    callGateway: deps?.callGateway ?? callGateway,
    toolsForScope: deps?.toolsForScope ?? toolsForScope,
    executeTool: deps?.executeTool ?? executeTool,
    retrieve: deps?.retrieve ?? retrieve,
    evaluateOutput: deps?.evaluateOutput ?? defaultEvaluateOutput,
  };
}

function formatRunStatusHeader(run: FlowRunView): string {
  if (run.status === 'stopped' && run.stopReason) {
    return `stopped;reason=${run.stopReason}`;
  }
  return run.status;
}

function draftToPublishedSnapshot(draft: FlowDefinition): PublishedFlowDefinition {
  const agentPromptVersions: Record<string, number | null> = {};
  const agentSnapshots: Record<string, PublishedAgentSnapshot> = {};
  for (const slug of draft.agents) {
    const agent = getAgentBySlug(slug);
    if (!agent) continue;
    let promptBody = agent.systemPrompt ?? '';
    let promptVariables: PromptVariable[] = [];
    let promptVersion: number | null = agent.publishedPromptVersion ?? null;
    try {
      const pub = getPublishedPrompt({ kind: 'agent', id: String(agent.id) });
      if (pub) {
        promptBody = pub.body;
        promptVariables = pub.variables;
        promptVersion = pub.version;
      }
    } catch {
      // ignore if prompts table missing
    }
    agentPromptVersions[slug] = promptVersion;
    agentSnapshots[slug] = {
      agentId: agent.id,
      slug: agent.slug,
      name: agent.name,
      model: agent.model,
      promptVersion,
      promptBody,
      promptVariables,
      knowledgeScopeKind: agent.knowledgeScopeKind,
      knowledgeScopeId: agent.knowledgeScopeId,
      outputPolicyScope: agent.outputPolicyScope,
      maxOutputTokens: agent.maxOutputTokens,
    };
  }
  return {
    ...draft,
    agentPromptVersions,
    agentSnapshots,
  };
}

function toUsageObject(run: FlowRunView): TokenUsage {
  return {
    prompt_tokens: run.promptTokens,
    completion_tokens: run.completionTokens,
    total_tokens: run.promptTokens + run.completionTokens,
  };
}

function buildPausedToolResultText(
  serverSlug: string | null | undefined,
  exposedName: string | null | undefined,
  status: string,
  resultMasked: string | null | undefined,
  errorText: string | null | undefined,
): string {
  if (status === 'succeeded') {
    return `<tool_result server="${serverSlug ?? 'mcp'}" tool="${exposedName ?? 'tool'}" trust="untrusted">\n${resultMasked ?? ''}\n</tool_result>`;
  }
  return JSON.stringify({
    error: {
      type: 'tool_error',
      message: errorText ?? resultMasked ?? 'Approved action did not succeed.',
    },
  });
}

async function applyFinalOutputGuard(params: {
  isDryRun: boolean;
  profileId: number;
  endUser: string | null;
  wire: Wire;
  stream: boolean;
  runId: string;
  agent: ResolvedAgentRuntime;
  renderedPrompt: string;
  text: string;
  req?: Request;
  signal: AbortSignal;
  deps: Required<OrchestratorEngineDeps>;
}): Promise<{ text: string; finishReason: 'stop' | 'content_filter'; guardHeader?: string }> {
  const { isDryRun, profileId, endUser, wire, stream, runId, agent, renderedPrompt, text, req, signal, deps } = params;
  if (isDryRun || profileId <= 0 || !text) {
    return { text, finishReason: 'stop' };
  }

  const guardScope = parseOutputPolicyScope(agent.outputPolicyScope, profileId);
  let evalRes: GuardEvaluateResult;
  try {
    evalRes = await deps.evaluateOutput(guardScope, text, {
      req,
      signal,
      endUser,
      wire,
      stream,
      systemPrompt: renderedPrompt || null,
      runId,
      canCallGateway: true,
    });
  } catch {
    return { text, finishReason: 'stop' };
  }

  if (evalRes.action === 'pass') {
    return { text, finishReason: 'stop' };
  }

  const guardHeader =
    (evalRes.action === 'blocked' || evalRes.action === 'masked') && evalRes.reason
      ? `${evalRes.action};reason=${evalRes.reason}`
      : evalRes.action;

  appendRunStep({
    runId,
    kind: 'guard',
    agentSlug: agent.slug,
    scopeForMasking: guardScope,
    input: { action: evalRes.action, ...(evalRes.reason ? { reason: evalRes.reason } : {}) },
    output: { text: evalRes.text },
    status: 'ok',
  });

  return {
    text: evalRes.text,
    finishReason: evalRes.action === 'blocked' ? 'content_filter' : 'stop',
    guardHeader,
  };
}

async function runAgentLoop(params: {
  runId: string;
  flowId: number;
  flowSlug: string;
  flowVersion: number;
  publishedFlow: PublishedFlowDefinition;
  profileId: number;
  endUser: string | null;
  wire: Wire;
  isDryRun: boolean;
  stream: boolean;
  initialAgentSlug: string;
  initialConversation?: ChatMessage[];
  initialPendingCalls?: ChatToolCall[];
  userMessages: ChatMessage[];
  userQuery: string;
  callerContext: CallerContextSnapshot;
  limiter: FlowRunLimiter;
  initialBestText: string;
  initialStepCount: number;
  req: Request;
  res?: Response;
  ac: AbortController;
  deps: Required<OrchestratorEngineDeps>;
}): Promise<FlowExecutionResult> {
  const {
    runId,
    flowId,
    flowSlug,
    flowVersion,
    publishedFlow,
    profileId,
    endUser,
    wire,
    isDryRun,
    stream,
    userMessages,
    userQuery,
    callerContext,
    limiter,
    req,
    res,
    ac,
    deps,
  } = params;

  const maskingScope: Scope =
    profileId > 0 ? { kind: 'profile', id: String(profileId) } : { kind: 'agent', id: '0' };

  let currentAgentSlug = params.initialAgentSlug;
  let currentAgent = resolveAgentRuntime(currentAgentSlug, publishedFlow, isDryRun);
  let bestTextSoFar = params.initialBestText;
  let stepCounter = params.initialStepCount;

  const nextStepSeq = () => {
    stepCounter += 1;
    return stepCounter;
  };

  let agentCtx = await buildIsolatedAgentContext({
    agent: currentAgent,
    flow: publishedFlow,
    userMessages,
    userQuery,
    callerContext,
    endUser,
    signal: ac.signal,
    deps,
  });

  if (params.initialConversation) {
    agentCtx.conversation = params.initialConversation;
  }

  const isAbortedOrCancelled = (): boolean => {
    if (ac.signal.aborted) return true;
    const dbStatus = getRunStatusInDb(runId);
    return dbStatus === 'cancelled';
  };

  const stopWithReason = async (stopReason: FlowStopReason, detail?: unknown): Promise<FlowExecutionResult> => {
    const seq = nextStepSeq();
    appendRunStep({
      runId,
      seq,
      kind: 'stop',
      agentSlug: currentAgent.slug,
      scopeForMasking: maskingScope,
      input: detail ?? { stopReason },
      output: { stopReason },
      status: 'ok',
    });
    emitSseProgress(res, stream, wire, runId, seq, currentAgent.slug, 'stop');

    const guarded = await applyFinalOutputGuard({
      isDryRun,
      profileId,
      endUser,
      wire,
      stream,
      runId,
      agent: currentAgent,
      renderedPrompt: agentCtx.renderedPrompt,
      text: bestTextSoFar,
      req,
      signal: ac.signal,
      deps,
    });

    const finished = finishRunRecord(runId, {
      status: 'stopped',
      stopReason,
      finalText: guarded.text,
      scopeForMasking: maskingScope,
      counters: limiter.getCounters(),
    });

    return {
      run: finished,
      outputText: guarded.text,
      finishReason: guarded.finishReason,
      usage: toUsageObject(finished),
      ...(guarded.guardHeader ? { guardHeader: guarded.guardHeader } : {}),
    };
  };

  const completeWithText = async (rawText: string): Promise<FlowExecutionResult> => {
    const guarded = await applyFinalOutputGuard({
      isDryRun,
      profileId,
      endUser,
      wire,
      stream,
      runId,
      agent: currentAgent,
      renderedPrompt: agentCtx.renderedPrompt,
      text: rawText,
      req,
      signal: ac.signal,
      deps,
    });

    const finished = finishRunRecord(runId, {
      status: 'completed',
      finalText: guarded.text,
      scopeForMasking: maskingScope,
      counters: limiter.getCounters(),
    });

    return {
      run: finished,
      outputText: guarded.text,
      finishReason: guarded.finishReason,
      usage: toUsageObject(finished),
      ...(guarded.guardHeader ? { guardHeader: guarded.guardHeader } : {}),
    };
  };

  const finishCancelled = (): FlowExecutionResult => {
    const current = getRunRecord(runId)?.run;
    if (current && current.status === 'cancelled') {
      return {
        run: current,
        outputText: bestTextSoFar,
        finishReason: 'stop',
        usage: toUsageObject(current),
      };
    }
    const finished = finishRunRecord(runId, {
      status: 'cancelled',
      finalText: bestTextSoFar,
      scopeForMasking: maskingScope,
      counters: limiter.getCounters(),
    });
    return {
      run: finished,
      outputText: bestTextSoFar,
      finishReason: 'stop',
      usage: toUsageObject(finished),
    };
  };

  const processToolCallBatch = async (
    toolCalls: ChatToolCall[],
  ): Promise<{ pausedResult?: FlowExecutionResult; stoppedResult?: FlowExecutionResult; handedOff?: boolean }> => {
    for (let idx = 0; idx < toolCalls.length; idx += 1) {
      if (isAbortedOrCancelled()) {
        return { stoppedResult: finishCancelled() };
      }

      const tc = toolCalls[idx]!;
      const fnName = tc.function.name;

      // 1. Virtual handoff tool (`transfer_to_<slug>`)
      if (fnName.startsWith('transfer_to_')) {
        const targetSlug = fnName.slice('transfer_to_'.length);
        const allowedTargets = publishedFlow.handoffs[currentAgent.slug] ?? [];
        if (publishedFlow.kind !== 'handoff' || !allowedTargets.includes(targetSlug)) {
          const errText = JSON.stringify({
            error: { type: 'blocked', message: `Unknown tool: ${fnName}` },
          });
          const seq = nextStepSeq();
          appendRunStep({
            runId,
            seq,
            kind: 'tool',
            agentSlug: currentAgent.slug,
            toolName: fnName,
            scopeForMasking: maskingScope,
            input: tc.function.arguments,
            output: errText,
            status: 'error',
            error: `Disallowed handoff target: ${targetSlug}`,
          });
          emitSseProgress(res, stream, wire, runId, seq, currentAgent.slug, 'tool');
          agentCtx.conversation.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: errText,
          });
          continue;
        }

        const handoffCheck = limiter.checkBeforeHandoff(currentAgent.slug, targetSlug);
        if (!handoffCheck.allowed) {
          return {
            stoppedResult: await stopWithReason(handoffCheck.stopReason, {
              from: currentAgent.slug,
              to: targetSlug,
            }),
          };
        }

        const parsedHandoffArgs = parseJsonObject(tc.function.arguments);
        const rawReason =
          typeof parsedHandoffArgs.reason === 'string'
            ? parsedHandoffArgs.reason
            : typeof parsedHandoffArgs.summary === 'string'
              ? parsedHandoffArgs.summary
              : '';
        const maskedReason = rawReason ? maskText(maskingScope, rawReason) : '';

        limiter.recordHandoff(targetSlug);
        updateRunProgress(runId, limiter.getCounters());

        const seq = nextStepSeq();
        appendRunStep({
          runId,
          seq,
          kind: 'handoff',
          agentSlug: currentAgent.slug,
          toolName: fnName,
          scopeForMasking: maskingScope,
          input: { from: currentAgent.slug, to: targetSlug, reason: maskedReason },
          output: { to: targetSlug },
          status: 'ok',
        });
        emitSseProgress(res, stream, wire, runId, seq, currentAgent.slug, 'handoff');

        // Per-agent isolation (T118): discard A's conversation/knowledge/tools; enter B fresh.
        const fromSlug = currentAgent.slug;
        currentAgentSlug = targetSlug;
        currentAgent = resolveAgentRuntime(targetSlug, publishedFlow, isDryRun);
        agentCtx = await buildIsolatedAgentContext({
          agent: currentAgent,
          flow: publishedFlow,
          userMessages,
          userQuery,
          callerContext,
          endUser,
          handoffFrom: fromSlug,
          handoffReason: maskedReason,
          signal: ac.signal,
          deps,
        });
        return { handedOff: true };
      }

      // 2. Agent-scoped MCP tool call
      const bound = agentCtx.mcpByExposedName.get(fnName);
      if (!bound) {
        // Cross-agent isolation (T118): tool not bound to current agent is rejected as unknown.
        const errText = JSON.stringify({
          error: { type: 'blocked', message: `Unknown tool for agent '${currentAgent.slug}': ${fnName}` },
        });
        const seq = nextStepSeq();
        appendRunStep({
          runId,
          seq,
          kind: 'tool',
          agentSlug: currentAgent.slug,
          toolName: fnName,
          scopeForMasking: maskingScope,
          input: tc.function.arguments,
          output: errText,
          status: 'error',
          error: 'Unknown tool for current agent',
        });
        emitSseProgress(res, stream, wire, runId, seq, currentAgent.slug, 'tool');
        agentCtx.conversation.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: errText,
        });
        continue;
      }

      const parsedArgs = parseToolArgs(tc.function.arguments);
      if (!parsedArgs.ok) {
        const errText = JSON.stringify({
          error: { type: 'tool_error', message: parsedArgs.error },
        });
        const seq = nextStepSeq();
        appendRunStep({
          runId,
          seq,
          kind: 'tool',
          agentSlug: currentAgent.slug,
          toolName: fnName,
          scopeForMasking: maskingScope,
          input: tc.function.arguments,
          output: errText,
          status: 'error',
          error: parsedArgs.error,
        });
        emitSseProgress(res, stream, wire, runId, seq, currentAgent.slug, 'tool');
        agentCtx.conversation.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: errText,
        });
        continue;
      }

      const toolCheck = limiter.checkBeforeToolCall(fnName, parsedArgs.value);
      if (!toolCheck.allowed) {
        return {
          stoppedResult: await stopWithReason(toolCheck.stopReason, {
            tool: fnName,
          }),
        };
      }

      limiter.recordToolCall(fnName, parsedArgs.value);
      updateRunProgress(runId, limiter.getCounters());

      const seq = nextStepSeq();
      const agentScope: Scope = { kind: 'agent', id: String(currentAgent.agentId) };
      const toolStartedAt = Date.now();
      const outcome = await deps.executeTool(
        {
          scope: agentScope,
          endUser,
          runId,
          turnId: runId,
          stepSeq: seq,
          signal: ac.signal,
        },
        bound,
        parsedArgs.value,
      );
      const toolDurationMs = Math.max(0, Date.now() - toolStartedAt);

      if (outcome.kind === 'awaiting_approval') {
        try {
          const ttlHours = Math.max(
            1,
            Math.min(
              FLOW_LIMITS.maxApprovalTtlHours,
              Math.trunc(publishedFlow.approvalTtlHours || FLOW_LIMITS.defaultApprovalTtlHours),
            ),
          );
          const expiresAt = new Date(Date.now() + ttlHours * 3600_000).toISOString();
          getDb()
            .prepare(`UPDATE custom_ai_approvals SET expires_at = ? WHERE id = ? AND status = 'pending'`)
            .run(expiresAt, outcome.approvalId);
        } catch {
          // Ignore if approvals table unavailable in unit mock
        }

        appendRunStep({
          runId,
          seq,
          kind: 'approval',
          agentSlug: currentAgent.slug,
          toolName: fnName,
          scopeForMasking: agentScope,
          input: parsedArgs.value,
          output: { status: 'awaiting_approval', approval_id: outcome.approvalId },
          durationMs: toolDurationMs,
          status: 'ok',
        });
        emitSseProgress(res, stream, wire, runId, seq, currentAgent.slug, 'approval');

        const continuation: RunContinuationState = {
          version: 1,
          approvalId: outcome.approvalId,
          pendingToolCall: tc,
          remainingToolCalls: toolCalls.slice(idx + 1),
          pausedAgentSlug: currentAgent.slug,
          agentConversation: agentCtx.conversation,
          userMessages,
          userQuery,
          callerContext,
          limiterSnapshot: limiter.toSnapshot(),
          bestTextSoFar,
          publishedFlow,
          flowId,
          flowSlug,
          flowVersion,
          isDryRun,
        };

        pauseRunForApproval(runId, limiter.getCounters(), JSON.stringify(continuation));
        const pausedRun = getRunRecord(runId)!.run;
        const awaitingText =
          publishedFlow.awaitingApprovalText || FLOW_LIMITS.defaultAwaitingApprovalText;

        return {
          pausedResult: {
            run: pausedRun,
            outputText: awaitingText,
            finishReason: 'stop',
            usage: toUsageObject(pausedRun),
          },
        };
      }

      const stepStatus = outcome.kind === 'error' ? 'error' : 'ok';
      appendRunStep({
        runId,
        seq,
        kind: 'tool',
        agentSlug: currentAgent.slug,
        toolName: fnName,
        scopeForMasking: agentScope,
        input: parsedArgs.value,
        output: outcome.text,
        durationMs: outcome.durationMs ?? toolDurationMs,
        status: stepStatus,
        ...(outcome.kind === 'error' ? { error: outcome.errorType } : {}),
      });
      emitSseProgress(res, stream, wire, runId, seq, currentAgent.slug, 'tool');

      agentCtx.conversation.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: outcome.text,
      });
    }

    return {};
  };

  // If resuming from an approved tool call, process any remaining tool calls from that batch first.
  if (params.initialPendingCalls && params.initialPendingCalls.length > 0) {
    const batchOutcome = await processToolCallBatch(params.initialPendingCalls);
    if (batchOutcome.pausedResult) return batchOutcome.pausedResult;
    if (batchOutcome.stoppedResult) return batchOutcome.stoppedResult;
  }

  // Main multi-step execution loop
  while (true) {
    if (isAbortedOrCancelled()) {
      return finishCancelled();
    }

    const stepCheck = limiter.checkBeforeModelStep();
    if (!stepCheck.allowed) {
      return await stopWithReason(stepCheck.stopReason);
    }

    const modelStartedAt = Date.now();
    const guardedContext = compactLoopMessagesForBudget({
      messages: agentCtx.conversation,
      model: currentAgent.model,
      profileId: profileId > 0 ? profileId : undefined,
      tools: agentCtx.tools,
      maxOutputTokens: currentAgent.maxOutputTokens ?? undefined,
    });
    const outboundMessages = guardedContext.messages;
    let gwRes: {
      message: ChatMessage;
      finishReason: string;
      usage: TokenUsage;
      servedModel: string;
    };

    try {
      gwRes = await deps.callGateway(req, {
        model: currentAgent.model,
        messages: outboundMessages,
        ...(agentCtx.tools.length > 0 ? { tools: agentCtx.tools } : {}),
        ...(currentAgent.maxOutputTokens != null
          ? { maxTokens: currentAgent.maxOutputTokens }
          : {}),
        skipEnrichment: true,
        ...(endUser !== null ? { endUser } : {}),
        runId,
        depth: 0,
        signal: ac.signal,
      });
    } catch (err) {
      if (isAbortedOrCancelled()) {
        return finishCancelled();
      }
      if (err instanceof GatewayCallError && err.status === 429) {
        return await stopWithReason('quota_exhausted', {
          status: err.status,
          code: err.code,
        });
      }
      const errMsg = err instanceof Error ? err.message : 'Model step failed.';
      const seq = nextStepSeq();
      appendRunStep({
        runId,
        seq,
        kind: 'model',
        agentSlug: currentAgent.slug,
        model: currentAgent.model,
        scopeForMasking: maskingScope,
        input: agentCtx.conversation,
        output: '',
        durationMs: Math.max(0, Date.now() - modelStartedAt),
        status: 'error',
        error: errMsg,
      });
      const failed = finishRunRecord(runId, {
        status: 'failed',
        error: errMsg,
        finalText: bestTextSoFar || null,
        scopeForMasking: maskingScope,
        counters: limiter.getCounters(),
      });
      throw Object.assign(new Error(errMsg), { flowRun: failed, cause: err });
    }

    const modelDurationMs = Math.max(0, Date.now() - modelStartedAt);
    const promptTokens = gwRes.usage?.prompt_tokens ?? 0;
    const completionTokens = gwRes.usage?.completion_tokens ?? 0;

    const { exceededTokenLimit } = limiter.recordModelStep(promptTokens, completionTokens);
    updateRunProgress(runId, limiter.getCounters());

    const assistantText = extractTextFromContent(gwRes.message.content);
    if (assistantText.trim().length > 0) {
      bestTextSoFar = assistantText;
    }

    const modelSeq = nextStepSeq();
    appendRunStep({
      runId,
      seq: modelSeq,
      kind: 'model',
      agentSlug: currentAgent.slug,
      model: gwRes.servedModel || currentAgent.model,
      scopeForMasking: maskingScope,
      input: agentCtx.conversation,
      output: gwRes.message,
      promptTokens,
      completionTokens,
      durationMs: modelDurationMs,
      status: 'ok',
    });
    emitSseProgress(res, stream, wire, runId, modelSeq, currentAgent.slug, 'model');

    if (isAbortedOrCancelled()) {
      return finishCancelled();
    }

    if (exceededTokenLimit) {
      return await stopWithReason('max_tokens', {
        totalTokens: limiter.getCounters().totalTokens,
        maxTokens: publishedFlow.limits.maxTokens,
      });
    }

    const toolCalls = gwRes.message.tool_calls ?? [];
    if (toolCalls.length === 0) {
      return await completeWithText(assistantText || bestTextSoFar);
    }

    agentCtx.conversation.push(gwRes.message);
    const batchOutcome = await processToolCallBatch(toolCalls);
    if (batchOutcome.pausedResult) return batchOutcome.pausedResult;
    if (batchOutcome.stoppedResult) return batchOutcome.stoppedResult;
  }
}

/**
 * Starts a new orchestrator flow run (`running -> completed | stopped | awaiting_approval | cancelled | failed`).
 */
export async function startRun(input: StartRunInput): Promise<FlowExecutionResult> {
  const flow =
    input.flowId !== undefined
      ? getFlow(input.flowId)
      : input.flowSlug !== undefined
        ? getFlowBySlug(input.flowSlug)
        : null;

  if (!flow) {
    throw new Error('Flow not found.');
  }

  const isDryRun = Boolean(input.isDryRun);
  const publishedFlow: PublishedFlowDefinition = isDryRun
    ? draftToPublishedSnapshot(flow.draft)
    : flow.published
      ? flow.published
      : (() => {
          throw new Error(`Flow '${flow.slug}' is not published.`);
        })();

  const flowVersion = isDryRun ? 0 : flow.publishedVersion;
  const runId = input.runId ?? `run_${crypto.randomUUID()}`;

  const callerMessages = input.messages.filter((m) => m.role !== 'system');
  const userMessages = callerMessages.filter((m) => m.role === 'user');
  const effectiveUserMessages = userMessages.length > 0 ? userMessages : callerMessages;
  const userQuery = extractLatestUserQuery(effectiveUserMessages);
  const callerContext = captureCallerContext(input.req, input.profileId);

  createRunRecord({
    id: runId,
    flowId: flow.id,
    flowSlug: flow.slug,
    flowVersion,
    profileId: input.profileId,
    endUser: input.endUser,
    wire: input.wire,
    isDryRun,
  });

  if (input.res && !input.res.headersSent) {
    input.res.setHeader('x-freellm-run-id', runId);
  }

  const ac = new AbortController();
  activeRunControllers.set(runId, ac);

  let onInboundAbort: (() => void) | undefined;
  if (input.signal) {
    if (input.signal.aborted) {
      cancelRun(runId, 'client_disconnect');
      ac.abort();
    } else {
      onInboundAbort = () => {
        cancelRun(runId, 'client_disconnect');
        ac.abort();
      };
      input.signal.addEventListener('abort', onInboundAbort, { once: true });
    }
  }

  const deps = resolveDeps(input.deps);
  const limiter = new FlowRunLimiter(publishedFlow.entryAgent, publishedFlow.limits);
  const req = input.req ?? buildSyntheticLoopbackReq(input.profileId, input.endUser);

  try {
    return await runAgentLoop({
      runId,
      flowId: flow.id,
      flowSlug: flow.slug,
      flowVersion,
      publishedFlow,
      profileId: input.profileId,
      endUser: input.endUser,
      wire: input.wire,
      isDryRun,
      stream: Boolean(input.stream),
      initialAgentSlug: publishedFlow.entryAgent,
      userMessages: effectiveUserMessages,
      userQuery,
      callerContext,
      limiter,
      initialBestText: '',
      initialStepCount: 0,
      req,
      res: input.res,
      ac,
      deps,
    });
  } catch (err) {
    const rec = getRunRecord(runId)?.run;
    if (rec && rec.status === 'running') {
      const scope: Scope =
        input.profileId > 0
          ? { kind: 'profile', id: String(input.profileId) }
          : { kind: 'agent', id: '0' };
      finishRunRecord(runId, {
        status: 'failed',
        error: err instanceof Error ? err.message : 'Flow run failed.',
        scopeForMasking: scope,
        counters: limiter.getCounters(),
      });
    }
    throw err;
  } finally {
    activeRunControllers.delete(runId);
    if (onInboundAbort && input.signal) {
      input.signal.removeEventListener('abort', onInboundAbort);
    }
  }
}

/**
 * Resumes an `awaiting_approval` flow run from its persisted continuation checkpoint
 * without repeating any prior model or tool calls (`T119`).
 */
export async function resumeRun(
  runId: string,
  approval: ResumeApprovalInput,
  opts?: { req?: Request; deps?: OrchestratorEngineDeps },
): Promise<FlowExecutionResult | null> {
  const rec = getRunRecord(runId);
  if (!rec) return null;
  if (rec.run.status !== 'awaiting_approval') return null;
  if (!rec.stateJson) {
    throw new Error(`Run '${runId}' is missing continuation state_json.`);
  }

  const state = JSON.parse(rec.stateJson) as RunContinuationState;
  const maskingScope: Scope =
    rec.run.profileId > 0
      ? { kind: 'profile', id: String(rec.run.profileId) }
      : { kind: 'agent', id: '0' };
  const deps = resolveDeps(opts?.deps);
  const limiter = FlowRunLimiter.fromSnapshot(state.limiterSnapshot, state.publishedFlow.limits);

  const stepRow = getDb()
    .prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM custom_ai_run_steps WHERE run_id = ?')
    .get(runId) as { max_seq: number };
  let stepCount = Number(stepRow?.max_seq ?? 0);

  if (!approval.approved) {
    stepCount += 1;
    const rejectionMsg = approval.note?.trim()
      ? `Action rejected by administrator: ${approval.note.trim()}`
      : 'Action rejected by administrator.';

    appendRunStep({
      runId,
      seq: stepCount,
      kind: 'approval',
      agentSlug: state.pausedAgentSlug,
      toolName: state.pendingToolCall.function.name,
      scopeForMasking: maskingScope,
      input: { approvalId: approval.id, decision: 'rejected', ...(approval.note ? { note: approval.note } : {}) },
      output: { rejected: true, message: rejectionMsg },
      status: 'ok',
    });

    const agent = resolveAgentRuntime(state.pausedAgentSlug, state.publishedFlow, state.isDryRun);
    const renderedPrompt = renderAgentPrompt(agent, state.callerContext, rec.run.endUser);
    const guarded = await applyFinalOutputGuard({
      isDryRun: state.isDryRun,
      profileId: rec.run.profileId,
      endUser: rec.run.endUser,
      wire: rec.run.wire,
      stream: false,
      runId,
      agent,
      renderedPrompt,
      text: rejectionMsg,
      req: opts?.req,
      signal: new AbortController().signal,
      deps,
    });

    const finished = finishRunRecord(runId, {
      status: 'completed',
      finalText: guarded.text,
      scopeForMasking: maskingScope,
      counters: limiter.getCounters(),
    });

    return {
      run: finished,
      outputText: guarded.text,
      finishReason: guarded.finishReason,
      usage: toUsageObject(finished),
      ...(guarded.guardHeader ? { guardHeader: guarded.guardHeader } : {}),
    };
  }

  markRunRunning(runId, null);

  const approvalRow = getDb()
    .prepare(
      `SELECT a.status, a.result_masked, a.error_text, t.exposed_name, s.slug AS server_slug
         FROM custom_ai_approvals a
         LEFT JOIN custom_ai_mcp_tools t ON t.id = a.tool_id
         LEFT JOIN custom_ai_mcp_servers s ON s.id = t.server_id
        WHERE a.id = ?`,
    )
    .get(approval.id) as
    | {
        status: string;
        result_masked: string | null;
        error_text: string | null;
        exposed_name: string | null;
        server_slug: string | null;
      }
    | undefined;

  const toolResultText = buildPausedToolResultText(
    approvalRow?.server_slug,
    approvalRow?.exposed_name ?? state.pendingToolCall.function.name,
    approvalRow?.status ?? 'succeeded',
    approvalRow?.result_masked,
    approvalRow?.error_text,
  );

  stepCount += 1;
  appendRunStep({
    runId,
    seq: stepCount,
    kind: 'approval',
    agentSlug: state.pausedAgentSlug,
    toolName: state.pendingToolCall.function.name,
    scopeForMasking: maskingScope,
    input: { approvalId: approval.id, decision: 'approved', ...(approval.note ? { note: approval.note } : {}) },
    output: toolResultText,
    status: approvalRow?.status === 'succeeded' || !approvalRow ? 'ok' : 'error',
    ...(approvalRow?.error_text ? { error: approvalRow.error_text } : {}),
  });

  const conversation: ChatMessage[] = [
    ...state.agentConversation,
    {
      role: 'tool',
      tool_call_id: state.pendingToolCall.id,
      content: toolResultText,
    },
  ];

  const ac = new AbortController();
  activeRunControllers.set(runId, ac);
  const req = buildSyntheticLoopbackReq(rec.run.profileId, rec.run.endUser, opts?.req);

  try {
    return await runAgentLoop({
      runId,
      flowId: state.flowId,
      flowSlug: state.flowSlug,
      flowVersion: state.flowVersion,
      publishedFlow: state.publishedFlow,
      profileId: rec.run.profileId,
      endUser: rec.run.endUser,
      wire: rec.run.wire,
      isDryRun: state.isDryRun,
      stream: false,
      initialAgentSlug: state.pausedAgentSlug,
      initialConversation: conversation,
      initialPendingCalls: state.remainingToolCalls,
      userMessages: state.userMessages,
      userQuery: state.userQuery,
      callerContext: state.callerContext,
      limiter,
      initialBestText: state.bestTextSoFar,
      initialStepCount: stepCount,
      req,
      ac,
      deps,
    });
  } catch (err) {
    const latest = getRunRecord(runId)?.run;
    if (latest && latest.status === 'running') {
      finishRunRecord(runId, {
        status: 'failed',
        error: err instanceof Error ? err.message : 'Resumed flow run failed.',
        finalText: state.bestTextSoFar || null,
        scopeForMasking: maskingScope,
        counters: limiter.getCounters(),
      });
    }
    throw err;
  } finally {
    activeRunControllers.delete(runId);
  }
}

/**
 * Cancels an active (`running` or `awaiting_approval`) flow run, aborting any in-flight work.
 */
export function cancelRun(runId: string, reason: 'client_disconnect' | 'admin'): boolean {
  activeRunControllers.get(runId)?.abort();
  const db = getDb();
  const errNote =
    reason === 'client_disconnect' ? 'Cancelled due to client disconnect.' : 'Cancelled by administrator.';
  const res = db
    .prepare(
      `UPDATE custom_ai_runs
          SET status = 'cancelled',
              error = COALESCE(error, ?),
              finished_at = datetime('now')
        WHERE id = ? AND status IN ('running', 'awaiting_approval')`,
    )
    .run(errNote, runId);

  if (res.changes > 0) {
    try {
      const hasApprovals = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'custom_ai_approvals'")
        .get();
      if (hasApprovals) {
        db.prepare(
          `UPDATE custom_ai_approvals
              SET status = 'rejected',
                  decision_note = COALESCE(decision_note, 'Run cancelled')
            WHERE run_id = ? AND status = 'pending'`,
        ).run(runId);
      }
    } catch {
      // Ignore if approvals table unavailable
    }
    return true;
  }
  return false;
}

/**
 * Marks any orphaned `running` runs as `interrupted` at process startup without re-executing steps.
 */
export function markInterruptedRuns(): number {
  const db = getDb();
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'custom_ai_runs'")
    .get();
  if (!exists) return 0;
  const res = db
    .prepare(
      `UPDATE custom_ai_runs
          SET status = 'interrupted',
              finished_at = datetime('now')
        WHERE status = 'running'`,
    )
    .run();
  return res.changes;
}

/**
 * Executes a `flow:<slug>` inference request over HTTP (`pipeline.ts` Slot 4) and sends the
 * formatted wire response (`openai-chat`, `anthropic`, `responses`, or `gemini`).
 */
export async function executeFlowHttpRequest(
  req: Request,
  res: Response,
  profileId: number,
  endUser: string | null,
  wire: Wire,
  stream: boolean,
  flowSlug: string,
  deps?: OrchestratorEngineDeps,
): Promise<void> {
  recordServerLocalAddress(req);

  const messages = toLoopbackMessages(wire, req.body);
  if (!messages || messages.length === 0) {
    res.status(400).json({
      error: {
        message: 'Unable to parse messages for flow execution.',
        type: 'invalid_request_error',
        code: 'invalid_request',
      },
    });
    return;
  }

  const ac = new AbortController();
  const onClose = () => {
    if (!res.writableFinished) {
      ac.abort();
    }
  };
  res.on('close', onClose);

  try {
    const result = await startRun({
      flowSlug,
      profileId,
      endUser,
      wire,
      messages,
      isDryRun: false,
      stream,
      req,
      res,
      signal: ac.signal,
      deps,
    });

    if (res.writableEnded || res.destroyed) return;

    if (!res.headersSent) {
      res.setHeader('x-freellm-run-id', result.run.id);
      res.setHeader('x-freellm-run-status', formatRunStatusHeader(result.run));
      if (result.guardHeader && isPillarEnabled('outputGuard')) {
        res.setHeader('x-freellm-guard', result.guardHeader);
      }
    }

    sendText(safeResponseForSendText(res), wire, stream, result.outputText, {
      model: `flow:${flowSlug}`,
      finish: result.finishReason,
      usage: result.usage,
    });
  } catch (err) {
    if (res.writableEnded || res.destroyed) return;
    if (!res.headersSent) {
      const status = err instanceof GatewayCallError ? err.status : 502;
      const code = err instanceof GatewayCallError ? err.code : 'flow_execution_failed';
      res.status(status).json({
        error: {
          message: err instanceof Error ? err.message : 'Flow execution failed.',
          type: status === 429 ? 'rate_limit_error' : 'api_error',
          code,
        },
      });
    } else if (!res.writableEnded) {
      res.end();
    }
  } finally {
    res.off('close', onClose);
  }
}
