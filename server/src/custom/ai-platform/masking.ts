import type { Scope } from '@freellmapi/shared/ai-platform.js';
import {
  maskSupportSensitiveData,
  maskSupportSensitiveText,
} from '../x-gateway/support-knowledge.js';

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_RE = /(?<!\w)(?:\+?\d[\d\s\-().]{7,}\d)(?!\w)/g;
const SECRET_TOKEN_RE = /\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{16,}|Bearer\s+[A-Za-z0-9._-]{12,})\b/gi;

function maskEmail(match: string): string {
  const at = match.indexOf('@');
  if (at <= 0) return '***';
  return `${match[0]}***${match.slice(at)}`;
}

function maskPhone(match: string): string {
  const digits = match.replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 15) return match;
  return `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}`;
}

function applyDefaultMaskText(input: string): string {
  return String(input ?? '')
    .replace(EMAIL_RE, maskEmail)
    .replace(SECRET_TOKEN_RE, '[redacted-token]')
    .replace(PHONE_RE, maskPhone);
}

function applyDefaultMaskData<T>(value: T): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return applyDefaultMaskText(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) {
        out[k] = walk(val);
      }
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

/**
 * Masks sensitive text according to scope:
 * - `support_tenant`: delegates to `maskSupportSensitiveText`
 * - `profile` / `agent`: applies built-in default PII/token masking (no DB writes, no role bypass)
 */
export function maskText(scope: Scope, text: string, role?: string): string {
  if (scope.kind === 'support_tenant') {
    return maskSupportSensitiveText(scope.id, text, role ?? 'customer').masked;
  }
  return applyDefaultMaskText(text);
}

/**
 * Recursively masks sensitive data according to scope.
 */
export function maskData<T>(scope: Scope, value: T, role?: string): T {
  if (scope.kind === 'support_tenant') {
    return maskSupportSensitiveData(scope.id, value, role ?? 'customer').masked;
  }
  return applyDefaultMaskData(value);
}
