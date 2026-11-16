/**
 * AiPlatformApp — root component for the /ai-platform/* sub-application.
 *
 * Scope (US1 / T032): Overview page with 6 pillar switches.
 * Future screens (US2–US7) render a "not yet implemented" placeholder
 * so they cannot accidentally link to unimplemented API routes.
 *
 * Rules:
 * - No sensitive query is sent when user lacks view_ai_platform.
 * - Editor (edit_ai_flags) can toggle switches; viewer cannot.
 * - All strings go through tc() for bilingual support.
 * - Native React only — no @testing-library/react import anywhere in this module.
 */

import { Routes, Route, NavLink } from 'react-router-dom';
import { useCustomT } from '../i18n/use-custom-t';
import { useAdministrativeAccess } from '../use-administrative-access';
import { useUserSession } from '../use-session';
import { Knowledge } from './pages/Knowledge';
import { McpServers } from './pages/McpServers';
import { OutputGuard } from './pages/OutputGuard';
import { Overview } from './pages/Overview';
import { PromptCache } from './pages/PromptCache';
import { Prompts } from './pages/Prompts';
import { KNOWLEDGE_NAV_HEADING } from './knowledge-strings';
import {
  NAV_AI_PLATFORM,
  NO_ACCESS,
  NOT_IMPLEMENTED_YET,
  PILLAR_PROMPTS,
  MCP_SERVERS_HEADING,
  OUTPUT_GUARD_HEADING,
  PROMPT_CACHE_HEADING,
  FLOWS_HEADING,
  RUNS_HEADING,
} from './strings';

// ─── Placeholder for unimplemented screens ────────────────────────────────────

function NotImplemented({ title }: { title: string }) {
  const tc = useCustomT();
  return (
    <div className="p-6 space-y-2">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="text-sm text-muted-foreground">{tc(NOT_IMPLEMENTED_YET)}</p>
    </div>
  );
}

// ─── Sub-nav ──────────────────────────────────────────────────────────────────

const NAV_ITEMS = [
  { to: 'overview', labelKey: 'Platform overview' as const },
] as const;

// Future screens — links shown but pages are placeholders until US6–US7 ship.
const FUTURE_NAV_ITEMS = [
  { to: 'flows', labelKey: FLOWS_HEADING },
  { to: 'runs', labelKey: RUNS_HEADING },
] as const;

// ─── Main app ─────────────────────────────────────────────────────────────────

export function AiPlatformApp() {
  const tc = useCustomT();
  const { can } = useAdministrativeAccess();
  const { isPrimary } = useUserSession();

  const canOverview = isPrimary || can('view_ai_platform') || can('edit_ai_flags') || can('manage_ai_platform');
  const canPrompts =
    isPrimary ||
    can('view_prompts') ||
    can('edit_prompts') ||
    can('publish_prompts');
  const canMcp =
    isPrimary ||
    can('view_mcp_servers') ||
    can('edit_mcp_servers') ||
    can('review_mcp_tools') ||
    can('approve_ai_actions');
  const canOutputGuard =
    isPrimary ||
    can('view_output_guard') ||
    can('edit_output_guard') ||
    can('view_guard_excerpts');
  const canViewKnowledge = isPrimary || can('view_retrieval');
  const canEditKnowledge = isPrimary || can('edit_retrieval');
  const canKnowledge = canViewKnowledge || canEditKnowledge;
  const canPromptCache = isPrimary || can('view_prompt_cache') || can('edit_prompt_cache');

  // Guard: no sensitive query when user lacks access.
  if (!canOverview && !canPrompts && !canMcp && !canOutputGuard && !canKnowledge && !canPromptCache) {
    return (
      <div className="p-6">
        <p className="text-sm text-muted-foreground">{tc(NO_ACCESS)}</p>
      </div>
    );
  }

  return (
    <Routes>
      <Route
        path="/ai-platform/*"
        element={
          <AiPlatformShell
            canOverview={canOverview}
            canPrompts={canPrompts}
            canMcp={canMcp}
            canOutputGuard={canOutputGuard}
            canViewKnowledge={canViewKnowledge}
            canEditKnowledge={canEditKnowledge}
            canPromptCache={canPromptCache}
          />
        }
      />
      <Route
        path="*"
        element={
          <AiPlatformShell
            canOverview={canOverview}
            canPrompts={canPrompts}
            canMcp={canMcp}
            canOutputGuard={canOutputGuard}
            canViewKnowledge={canViewKnowledge}
            canEditKnowledge={canEditKnowledge}
            canPromptCache={canPromptCache}
          />
        }
      />
    </Routes>
  );
}

function AiPlatformShell({
  canOverview,
  canPrompts,
  canMcp,
  canOutputGuard,
  canViewKnowledge,
  canEditKnowledge,
  canPromptCache,
}: {
  canOverview: boolean;
  canPrompts: boolean;
  canMcp: boolean;
  canOutputGuard: boolean;
  canViewKnowledge: boolean;
  canEditKnowledge: boolean;
  canPromptCache: boolean;
}) {
  const tc = useCustomT();
  const canKnowledge = canViewKnowledge || canEditKnowledge;
  const defaultElement = canOverview ? (
    <Overview />
  ) : canPrompts ? (
    <Prompts />
  ) : canMcp ? (
    <McpServers />
  ) : canOutputGuard ? (
    <OutputGuard />
  ) : canKnowledge ? (
    <Knowledge
      canView={canViewKnowledge}
      canEdit={canEditKnowledge}
      canReindex={canEditKnowledge}
      canQuery={canViewKnowledge}
    />
  ) : (
    <PromptCache />
  );

  return (
    <div className="flex gap-6">
      {/* Sub-navigation */}
      <nav className="w-48 shrink-0 pt-6 pl-6" aria-label={tc(NAV_AI_PLATFORM)}>
        <div className="space-y-1">
          {canOverview && NAV_ITEMS.map(({ to, labelKey }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `block px-3 py-2 rounded-md text-sm transition-colors ${
                  isActive
                    ? 'bg-primary/10 text-primary font-medium'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                }`
              }
            >
              {tc(labelKey)}
            </NavLink>
          ))}
          {canPrompts && (
            <NavLink
              to="prompts"
              className={({ isActive }) =>
                `block px-3 py-2 rounded-md text-sm transition-colors ${
                  isActive
                    ? 'bg-primary/10 text-primary font-medium'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                }`
              }
            >
              {tc(PILLAR_PROMPTS)}
            </NavLink>
          )}
          {canMcp && (
            <NavLink
              to="mcp"
              className={({ isActive }) =>
                `block px-3 py-2 rounded-md text-sm transition-colors ${
                  isActive
                    ? 'bg-primary/10 text-primary font-medium'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                }`
              }
            >
              {tc(MCP_SERVERS_HEADING)}
            </NavLink>
          )}
          {canOutputGuard && (
            <NavLink
              to="output-guard"
              className={({ isActive }) =>
                `block px-3 py-2 rounded-md text-sm transition-colors ${
                  isActive
                    ? 'bg-primary/10 text-primary font-medium'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                }`
              }
            >
              {tc(OUTPUT_GUARD_HEADING)}
            </NavLink>
          )}
          {canKnowledge && (
            <NavLink
              to="knowledge"
              className={({ isActive }) =>
                `block px-3 py-2 rounded-md text-sm transition-colors ${
                  isActive
                    ? 'bg-primary/10 text-primary font-medium'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                }`
              }
            >
              {tc(KNOWLEDGE_NAV_HEADING)}
            </NavLink>
          )}
          {canPromptCache && (
            <NavLink
              to="prompt-cache"
              className={({ isActive }) =>
                `block px-3 py-2 rounded-md text-sm transition-colors ${
                  isActive
                    ? 'bg-primary/10 text-primary font-medium'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                }`
              }
            >
              {tc(PROMPT_CACHE_HEADING)}
            </NavLink>
          )}
          {/* Future screens — rendered as nav links but go to placeholder pages */}
          {FUTURE_NAV_ITEMS.map(({ to, labelKey }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `block px-3 py-2 rounded-md text-sm transition-colors ${
                  isActive
                    ? 'bg-primary/10 text-primary font-medium'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                }`
              }
            >
              {tc(labelKey)}
            </NavLink>
          ))}
        </div>
      </nav>

      {/* Page content */}
      <div className="flex-1">
        <Routes>
          <Route index element={defaultElement} />
          <Route path="overview" element={<Overview />} />
          <Route
            path="prompts"
            element={
              canPrompts ? (
                <Prompts />
              ) : (
                <div className="p-6">
                  <p className="text-sm text-muted-foreground">{tc(NO_ACCESS)}</p>
                </div>
              )
            }
          />
          <Route path="mcp" element={<McpServers />} />
          <Route path="output-guard" element={<OutputGuard />} />
          <Route
            path="knowledge"
            element={
              canKnowledge ? (
                <Knowledge
                  canView={canViewKnowledge}
                  canEdit={canEditKnowledge}
                  canReindex={canEditKnowledge}
                  canQuery={canViewKnowledge}
                />
              ) : (
                <div className="p-6">
                  <p className="text-sm text-muted-foreground">{tc(NO_ACCESS)}</p>
                </div>
              )
            }
          />

          <Route
            path="prompt-cache"
            element={
              canPromptCache ? (
                <PromptCache />
              ) : (
                <div className="p-6">
                  <p className="text-sm text-muted-foreground">{tc(NO_ACCESS)}</p>
                </div>
              )
            }
          />

          {/* Future US6–US7 screens — placeholder until implemented */}
          <Route path="flows" element={<NotImplemented title={tc(FLOWS_HEADING)} />} />
          <Route path="runs" element={<NotImplemented title={tc(RUNS_HEADING)} />} />

          {/* Catch-all */}
          <Route path="*" element={defaultElement} />
        </Routes>
      </div>
    </div>
  );
}
