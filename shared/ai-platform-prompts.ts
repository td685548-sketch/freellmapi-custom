import type { Scope, ScopeKind } from './ai-platform.js';

export type PromptVariableSource = 'system' | 'caller' | 'custom';

export interface PromptVariable {
  name: string;
  source: PromptVariableSource;
  default?: string;
  description?: string;
}

export type PromptVersionStatus = 'draft' | 'published' | 'archived';

export interface PromptVersionSummary {
  id: number;
  scopeKind: ScopeKind;
  scopeId: string;
  version: number;
  variables: PromptVariable[];
  note: string;
  status: PromptVersionStatus;
  restoredFrom: number | null;
  authorId: number | null;
  createdAt: string;
}

export interface PromptVersion extends PromptVersionSummary {
  body: string;
}

export interface PromptHead {
  scopeKind: ScopeKind;
  scopeId: string;
  publishedVersion: number | null;
  draftVersion: number | null;
  revision: number;
}

export interface PromptScopeStateResponse {
  scope: Scope;
  head: PromptHead;
  published: PromptVersion | null;
  draft: PromptVersion | null;
  versions: PromptVersionSummary[];
  prunedCount: number;
}

export interface PromptVersionResponse {
  version: PromptVersion;
}

export interface PromptDiffLine {
  type: 'same' | 'add' | 'remove';
  text: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
}

export interface PromptDiffStats {
  added: number;
  removed: number;
  unchanged: number;
}

export interface PromptDiffResponse {
  from: PromptVersionSummary;
  to: PromptVersionSummary;
  hunks: PromptDiffLine[];
  stats: PromptDiffStats;
}

export interface PromptDraftInput {
  body: string;
  variables?: PromptVariable[];
  note?: string;
  revision: number;
}

export interface PromptPreviewRequest {
  version?: number;
  body?: string;
  variables?: PromptVariable[];
  values?: Record<string, string>;
}

export interface PromptPreviewResponse {
  rendered: string;
  missing: string[];
}

export interface PromptTryRequest {
  version?: number;
  body?: string;
  variables?: PromptVariable[];
  values?: Record<string, string>;
  message: string;
  model?: string;
}

export interface PromptTryResponse {
  reply: string;
  rendered: string;
  missing: string[];
  model: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface PromptPublishRequest {
  revision: number;
}

export interface PromptRestoreRequest {
  version: number;
  revision: number;
}

export interface SystemPromptVariableDescriptor {
  name: string;
  source: 'system';
  description: string;
  example: string;
  dynamicPerRequest: boolean;
}

export const SYSTEM_PROMPT_VARIABLES: readonly SystemPromptVariableDescriptor[] = [
  {
    name: 'date',
    source: 'system',
    description: 'Current UTC date (YYYY-MM-DD)',
    example: '2026-11-16',
    dynamicPerRequest: true,
  },
  {
    name: 'profile_name',
    source: 'system',
    description: 'Client profile or support tenant display name',
    example: 'Default Profile',
    dynamicPerRequest: false,
  },
  {
    name: 'end_user_id',
    source: 'system',
    description: 'End-user identifier from X-End-User or body.user',
    example: 'user_42',
    dynamicPerRequest: true,
  },
  {
    name: 'end_user_name',
    source: 'system',
    description: 'End-user display name from X-End-User-Name or support context',
    example: 'Alice Nguyen',
    dynamicPerRequest: true,
  },
  {
    name: 'language',
    source: 'system',
    description: 'Resolved caller language tag (e.g. vi, en)',
    example: 'vi',
    dynamicPerRequest: true,
  },
] as const;

export const SYSTEM_PROMPT_VARIABLE_NAMES: ReadonlySet<string> = new Set(
  SYSTEM_PROMPT_VARIABLES.map((v) => v.name),
);

export const PROMPT_LIMITS = {
  maxBodyChars: 32_000,
  maxNoteChars: 500,
  maxRetainedVersions: 50,
  maxVarNameChars: 32,
  maxCallerVarsHeaderBytes: 2_048,
  maxCallerVarValueChars: 200,
  maxTryMessageChars: 8_000,
} as const;

export const PROMPT_VAR_NAME_REGEX = /^[a-z][a-z0-9_]{0,31}$/;
