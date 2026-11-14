import type { Request } from 'express';
import { getDb } from '../../../db/index.js';
import { extractInferenceToken } from '../../../middleware/user-rate-limit.js';
import type { GateProfile } from '../../../services/profile-usage.js';
import { isInternalCall } from '../loopback.js';
import type { Scope } from '../scope.js';
import type { Wire } from '../wire/detect.js';

const KB_REFERENCE_MARKER = 'Reference material from this website. Use it when it answers the question';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === 'string') {
      parts.push(item);
      continue;
    }
    const block = asRecord(item);
    if (block && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n');
}

/**
 * Removes reference-data blocks (`<tool_result>`, `<knowledge>`, `<reference_data>`,
 * and `knowledgeBlock` reference passages) so legitimate knowledge citations are
 * not treated as leaked system instructions.
 */
export function stripReferenceDataBlocks(text: string): string {
  if (!text) return '';
  let cleaned = text
    .replace(/<tool_result\b[^>]*>[\s\S]*?<\/tool_result>/gi, '')
    .replace(/<knowledge\b[^>]*>[\s\S]*?<\/knowledge>/gi, '')
    .replace(/<reference_data\b[^>]*>[\s\S]*?<\/reference_data>/gi, '');

  const kbIdx = cleaned.indexOf(KB_REFERENCE_MARKER);
  if (kbIdx !== -1) {
    cleaned = cleaned.slice(0, kbIdx);
  }
  return cleaned.trim();
}

/**
 * Extracts the effective system prompt by combining the stored profile/tenant
 * system prompt with actual caller `system` / `developer` instructions across
 * all four chat wire protocols, excluding reference-data blocks.
 */
export function extractEffectiveSystemPrompt(options: {
  wire: Wire;
  body: unknown;
  storedSystemPrompt?: string | null;
}): string | null {
  const parts: string[] = [];
  const pushClean = (raw: unknown) => {
    if (typeof raw !== 'string') return;
    const cleaned = stripReferenceDataBlocks(raw);
    if (cleaned && !parts.includes(cleaned)) {
      parts.push(cleaned);
    }
  };

  pushClean(options.storedSystemPrompt);

  const body = asRecord(options.body);
  if (body) {
    if (options.wire === 'openai-chat' && Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        const m = asRecord(msg);
        if (m && (m.role === 'system' || m.role === 'developer')) {
          pushClean(textOfContent(m.content));
        }
      }
    } else if (options.wire === 'anthropic') {
      pushClean(textOfContent(body.system));
    } else if (options.wire === 'responses') {
      pushClean(typeof body.instructions === 'string' ? body.instructions : '');
      if (Array.isArray(body.input)) {
        for (const item of body.input) {
          const it = asRecord(item);
          if (it && (it.role === 'system' || it.role === 'developer')) {
            pushClean(textOfContent(it.content));
          }
        }
      }
    } else if (options.wire === 'gemini') {
      const si = asRecord(body.systemInstruction);
      if (si && Array.isArray(si.parts)) {
        pushClean(textOfContent(si.parts));
      }
    }
  }

  return parts.length > 0 ? parts.join('\n\n') : null;
}

/**
 * Resolves the trusted guard role for profile inference.
 * Never trusts client-supplied `x-user-role` headers or `body.role`;
 * always returns a restricted default (`'end_user'`).
 */
export function resolveProfileGuardRole(_req: Request, _endUser: string | null): string {
  return 'end_user';
}

export function readStoredProfileSystemPrompt(profileId: number): string | null {
  try {
    const db = getDb();
    const row = db
      .prepare('SELECT system_prompt AS systemPrompt FROM client_profiles WHERE id = ?')
      .get(profileId) as { systemPrompt?: string | null } | undefined;
    return typeof row?.systemPrompt === 'string' && row.systemPrompt.trim().length > 0
      ? row.systemPrompt
      : null;
  } catch {
    return null;
  }
}

export interface ProfileGuardContext {
  scope: Scope;
  role: string;
  endUser: string | null;
  wire: Wire;
  stream: boolean;
  systemPrompt: string | null;
  canRunExternalJudge: boolean;
}

export function buildProfileGuardContext(
  req: Request,
  profile: GateProfile & { systemPrompt?: string | null },
  endUser: string | null,
  wire: Wire,
  stream: boolean,
): ProfileGuardContext {
  const stored =
    profile.systemPrompt !== undefined ? profile.systemPrompt : readStoredProfileSystemPrompt(profile.id);
  const systemPrompt = extractEffectiveSystemPrompt({
    wire,
    body: req.body,
    storedSystemPrompt: stored,
  });
  const role = resolveProfileGuardRole(req, endUser);
  const token = extractInferenceToken(req);
  const canRunExternalJudge = Boolean(token) && isInternalCall(req) === null;

  return {
    scope: { kind: 'profile', id: String(profile.id) },
    role,
    endUser,
    wire,
    stream,
    systemPrompt,
    canRunExternalJudge,
  };
}
