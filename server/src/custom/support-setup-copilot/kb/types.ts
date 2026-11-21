/**
 * Setup Copilot Platform Knowledge Base (RAG) — shared types.
 *
 * The KB teaches the Copilot how this website is structured and what every
 * setting does, so its answers are grounded in the product instead of in a
 * hand-written prompt blob. Everything here is read-only and in-process.
 */
import type { Permission } from '@freellmapi/shared/permissions.js';

export type KbSource =
  | 'permission'
  | 'setting'
  | 'tenant_step'
  | 'page'
  | 'troubleshooting'
  | 'option'
  | 'doc';

export interface KbChunk {
  /** Stable id, e.g. `setting:response_cache`, `perm:edit_cache`, `doc:en/auth/...#2`. */
  id: string;
  source: KbSource;
  title: string;
  titleVi?: string;
  /** English body (always present). */
  text: string;
  /** Vietnamese body when the source is bilingual. */
  textVi?: string;
  /** In-app route to send the user to, when the chunk describes a screen. */
  path?: string;
  /** Repo doc file the chunk came from (docs only). */
  docFile?: string;
  tags: string[];
  /** The leaf/parent permission needed to *use* the thing described (hides it from callers lacking it). */
  requiredPermission?: Permission;
}

export interface KbCaller {
  role?: string;
  isPrimary?: boolean;
  permissions?: readonly string[];
}

export interface KbHit {
  chunk: KbChunk;
  score: number;
  /** Which signals matched, for debugging / evaluation. */
  via: Array<'lexical' | 'semantic'>;
}

export interface KbSearchOptions {
  limit?: number;
  caller?: KbCaller;
  locale?: 'vi' | 'en';
  /** Current screen path; chunks describing it get a small boost. */
  currentPath?: string;
}
