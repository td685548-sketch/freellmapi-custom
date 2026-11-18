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

import { Routes, Route, NavLink, Navigate } from 'react-router-dom';
import { PageHeader } from '@/components/page-header';
import { useCustomT } from '../i18n/use-custom-t';
import { useAdministrativeAccess } from '../use-administrative-access';
import { useUserSession } from '../use-session';
import { Flows } from './pages/Flows';
import { Knowledge } from './pages/Knowledge';
import { McpServers } from './pages/McpServers';
import { OutputGuard } from './pages/OutputGuard';
import { Overview } from './pages/Overview';
import { PromptCache } from './pages/PromptCache';
import { SemanticCache } from './pages/SemanticCache';
import { Prompts } from './pages/Prompts';
import { Runs } from './pages/Runs';
import { TraceTimelinePage } from './pages/TraceTimelinePage';
import { AdminCustomerAiPanel } from '../customer-ai/AdminCustomerAiPanel';
import { KNOWLEDGE_NAV_HEADING } from './knowledge-strings';
import { SEMANTIC_CACHE_NAV_HEADING } from './semantic-cache-strings';
import { TRACES_NAV_HEADING } from './tracing-strings';
import {
  NAV_AI_PLATFORM,
  PAGE_TITLE,
  PAGE_SUBTITLE,
  NO_ACCESS,
  PILLAR_PROMPTS,
  MCP_SERVERS_HEADING,
  OVERVIEW_HEADING,
  OUTPUT_GUARD_HEADING,
  PROMPT_CACHE_HEADING,
  FLOWS_HEADING,
  RUNS_HEADING,
} from './strings';

// ─── Sub-nav ──────────────────────────────────────────────────────────────────

// Absolute paths: React Router 7 resolves a relative link inside a splat route
// against the whole current URL, so `to="prompts"` on /ai-platform/overview went
// to /ai-platform/overview/prompts and kept growing with every click.
const BASE = '/ai-platform';

// Same pill-tab idiom as ModelsTabs / SegmentedControl on the main dashboard.
const tabClass = ({ isActive }: { isActive: boolean }) =>
  `inline-flex items-center px-3 py-1.5 text-xs rounded-lg transition-colors ${
    isActive ? 'bg-foreground text-background font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-muted'
  }`;

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
  const canFlows = isPrimary || can('view_flows') || can('edit_flows') || can('publish_flows');
  const canRuns =
    isPrimary ||
    can('view_flow_runs') ||
    can('cancel_flow_runs') ||
    can('approve_ai_actions');
  const canCustomerAi =
    isPrimary ||
    can('view_prompts') ||
    can('edit_prompts') ||
    can('view_ai_platform') ||
    can('edit_ai_flags') ||
    can('manage_ai_platform');

  // Guard: no sensitive query when user lacks access.
  if (
    !canOverview &&
    !canPrompts &&
    !canMcp &&
    !canOutputGuard &&
    !canKnowledge &&
    !canPromptCache &&
    !canFlows &&
    !canRuns &&
    !canCustomerAi
  ) {
    return (
      <div>
        <p className="text-sm text-muted-foreground">{tc(NO_ACCESS)}</p>
      </div>
    );
  }

  return (
    <AiPlatformShell
      canOverview={canOverview}
      canPrompts={canPrompts}
      canMcp={canMcp}
      canOutputGuard={canOutputGuard}
      canViewKnowledge={canViewKnowledge}
      canEditKnowledge={canEditKnowledge}
      canPromptCache={canPromptCache}
      canFlows={canFlows}
      canRuns={canRuns}
      canCustomerAi={canCustomerAi}
    />
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
  canFlows,
  canRuns,
  canCustomerAi,
}: {
  canOverview: boolean;
  canPrompts: boolean;
  canMcp: boolean;
  canOutputGuard: boolean;
  canViewKnowledge: boolean;
  canEditKnowledge: boolean;
  canPromptCache: boolean;
  canFlows: boolean;
  canRuns: boolean;
  canCustomerAi: boolean;
}) {
  const tc = useCustomT();
  const canKnowledge = canViewKnowledge || canEditKnowledge;
  // /ai-platform opens the first section the account may see, by its own URL,
  // so the matching tab is highlighted like on every other tabbed page.
  const defaultPath = canOverview ? 'overview'
    : canPrompts ? 'prompts'
    : canMcp ? 'mcp'
    : canOutputGuard ? 'output-guard'
    : canKnowledge ? 'knowledge'
    : canPromptCache ? 'prompt-cache'
    : canFlows ? 'flows'
    : canRuns ? 'runs'
    : 'customer-ai';
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
  ) : canPromptCache ? (
    <PromptCache />
  ) : canFlows ? (
    <Flows />
  ) : canRuns ? (
    <Runs />
  ) : (
    <AdminCustomerAiPanel />
  );

  return (
    <div>
      <PageHeader
        title={tc(PAGE_TITLE)}
        description={tc(PAGE_SUBTITLE)}
        actions={
          <nav
            aria-label={tc(NAV_AI_PLATFORM)}
            className="inline-flex max-w-full gap-1 overflow-x-auto rounded-xl border p-1 [&>a]:shrink-0"
          >
            {canOverview && (
              <NavLink to={`${BASE}/overview`} className={tabClass}>
                {tc(OVERVIEW_HEADING)}
              </NavLink>
            )}
            {canPrompts && (
              <NavLink to={`${BASE}/prompts`} className={tabClass}>
                {tc(PILLAR_PROMPTS)}
              </NavLink>
            )}
            {canMcp && (
              <NavLink to={`${BASE}/mcp`} className={tabClass}>
                {tc(MCP_SERVERS_HEADING)}
              </NavLink>
            )}
            {canOutputGuard && (
              <NavLink to={`${BASE}/output-guard`} className={tabClass}>
                {tc(OUTPUT_GUARD_HEADING)}
              </NavLink>
            )}
            {canKnowledge && (
              <NavLink to={`${BASE}/knowledge`} className={tabClass}>
                {tc(KNOWLEDGE_NAV_HEADING)}
              </NavLink>
            )}
            {canPromptCache && (
              <NavLink to={`${BASE}/prompt-cache`} className={tabClass}>
                {tc(PROMPT_CACHE_HEADING)}
              </NavLink>
            )}
            {canPromptCache && (
              <NavLink to={`${BASE}/semantic-cache`} className={tabClass}>
                {tc(SEMANTIC_CACHE_NAV_HEADING)}
              </NavLink>
            )}
            {canFlows && (
              <NavLink to={`${BASE}/flows`} className={tabClass}>
                {tc(FLOWS_HEADING)}
              </NavLink>
            )}
            {canRuns && (
              <NavLink to={`${BASE}/runs`} className={tabClass}>
                {tc(RUNS_HEADING)}
              </NavLink>
            )}
            {canOverview && (
              <NavLink to={`${BASE}/traces`} data-testid="ai-platform-tab-traces" className={tabClass}>
                {tc(TRACES_NAV_HEADING)}
              </NavLink>
            )}
            {canCustomerAi && (
              <NavLink to={`${BASE}/customer-ai`} className={tabClass}>
                {tc('Customer AI')}
              </NavLink>
            )}
          </nav>
        }
      />

      {/* Page content */}
      <div>
        <Routes>
          <Route index element={<Navigate to={`${BASE}/${defaultPath}`} replace />} />
          <Route path="overview" element={<Overview />} />
          <Route
            path="prompts"
            element={
              canPrompts ? (
                <Prompts />
              ) : (
                <div>
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
                <div>
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
                <div>
                  <p className="text-sm text-muted-foreground">{tc(NO_ACCESS)}</p>
                </div>
              )
            }
          />
          <Route
            path="semantic-cache"
            element={
              canPromptCache ? (
                <SemanticCache />
              ) : (
                <div>
                  <p className="text-sm text-muted-foreground">{tc(NO_ACCESS)}</p>
                </div>
              )
            }
          />

          <Route
            path="flows"
            element={
              canFlows ? (
                <Flows />
              ) : (
                <div>
                  <p className="text-sm text-muted-foreground">{tc(NO_ACCESS)}</p>
                </div>
              )
            }
          />
          <Route
            path="runs"
            element={
              canRuns ? (
                <Runs />
              ) : (
                <div>
                  <p className="text-sm text-muted-foreground">{tc(NO_ACCESS)}</p>
                </div>
              )
            }
          />
          <Route
            path="traces"
            element={
              canOverview ? (
                <TraceTimelinePage />
              ) : (
                <div>
                  <p className="text-sm text-muted-foreground">{tc(NO_ACCESS)}</p>
                </div>
              )
            }
          />
          <Route
            path="customer-ai"
            element={
              canCustomerAi ? (
                <AdminCustomerAiPanel />
              ) : (
                <div>
                  <p className="text-sm text-muted-foreground">{tc(NO_ACCESS)}</p>
                </div>
              )
            }
          />

          {/* Catch-all */}
          <Route path="*" element={defaultElement} />
        </Routes>
      </div>
    </div>
  );
}
