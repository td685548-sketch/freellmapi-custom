import { createHash } from 'node:crypto';
import type { Request } from 'express';
import {
  CONTEXT_POLICY_DEFAULT,
  type ContextAssemblySummary,
  type ContextPolicy,
} from '@freellmapi/shared/context-budget.js';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import { contentToString } from '../../lib/content.js';
import { estimateTextTokens } from './estimate.js';

export type RegisteredUnitKind = 'summary' | 'knowledge' | 'history';

export interface RegisteredUnit {
  kind: RegisteredUnitKind;
  role: string;
  fingerprint: string;
  seq: number;
  messageId?: number;
  tokens: number;
  text: string;
}

export interface RegisterUnitInput {
  kind: RegisteredUnitKind;
  role: string;
  text: unknown;
  seq: number;
  messageId?: number;
}

export interface RegistryConversation {
  id: number;
  key: string;
  endUser: string | null;
}

export interface SegmentRegistry {
  policy: ContextPolicy;
  units: RegisteredUnit[];
  conversation: RegistryConversation | null;
  base: ChatMessage[] | null;
  lastOutput: ChatMessage[] | null;
  windowStartMessageId: number | null;
  report: ContextAssemblySummary | null;
  fitted: boolean;
  clientMaxTokens: number | null;
  provisionalBudget: number | null;
  mandatoryTokens: number | null;
  refits: number;
  trace: unknown;
  imageTokens: number;
  knowledgeDropped: boolean;
}

export interface CreateRegistryOptions {
  imageTokens?: number;
  clientMaxTokens?: number | null;
}

const registries = new WeakMap<Request, SegmentRegistry>();

/**
 * Normalize message text with Unicode NFC + trim and return the first 16 hex
 * characters of its SHA-1 digest for protocol-agnostic segment matching.
 */
export function computeFingerprint(content: unknown): string {
  const normalized = contentToString(content).normalize('NFC').trim();
  return createHash('sha1').update(normalized, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Retrieve the SegmentRegistry associated with an Express request, if any.
 */
export function getRegistry(req: Request): SegmentRegistry | undefined {
  return registries.get(req);
}

/**
 * Create and attach a fresh SegmentRegistry to an Express request.
 */
export function createRegistry(
  req: Request,
  policy: ContextPolicy,
  options: CreateRegistryOptions = {},
): SegmentRegistry {
  const registry: SegmentRegistry = {
    policy,
    units: [],
    conversation: null,
    base: null,
    lastOutput: null,
    windowStartMessageId: null,
    report: null,
    fitted: false,
    clientMaxTokens: options.clientMaxTokens ?? null,
    provisionalBudget: null,
    mandatoryTokens: null,
    refits: 0,
    trace: null,
    imageTokens: options.imageTokens ?? CONTEXT_POLICY_DEFAULT.imageTokens,
    knowledgeDropped: false,
  };
  registries.set(req, registry);
  return registry;
}

/**
 * Register a gateway-injected unit (summary, knowledge, or history) on the
 * request's registry with a computed NFC+trimmed SHA-1 fingerprint and token estimate.
 */
export function registerUnit(req: Request, input: RegisterUnitInput): RegisteredUnit | undefined {
  const registry = registries.get(req);
  if (!registry) return undefined;

  const normalized = contentToString(input.text).normalize('NFC').trim();
  const unit: RegisteredUnit = {
    kind: input.kind,
    role: input.role,
    fingerprint: computeFingerprint(normalized),
    seq: input.seq,
    ...(input.messageId !== undefined ? { messageId: input.messageId } : {}),
    tokens: estimateTextTokens(normalized),
    text: normalized,
  };
  registry.units.push(unit);
  return unit;
}
