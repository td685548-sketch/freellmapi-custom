import type { Permission } from '@freellmapi/shared/permissions.js';

const PREFIX = '/api/ai-platform';

function normalizeSubPath(rawPath: string): string {
  const clean = rawPath.split('?')[0]!.replace(/\/+$/, '').toLowerCase();
  if (clean === PREFIX) return '/';
  if (clean.startsWith(`${PREFIX}/`)) return clean.slice(PREFIX.length);
  return clean.startsWith('/') ? clean : `/${clean}`;
}

/**
 * Maps `/api/ai-platform/*` HTTP method + path to the exact child permission
 * defined in `contracts/admin-api.md`. Unrecognized routes fall back to `manage_ai_platform`.
 */
export function aiPlatformPermission(method: string, path: string): Permission {
  const upper = method.toUpperCase();
  const read = upper === 'GET' || upper === 'HEAD';
  const sub = normalizeSubPath(path);

  // Foundation & Request Tracing
  if (sub === '/overview' && read) return 'view_ai_platform';
  if (sub === '/flags' && upper === 'PUT') return 'edit_ai_flags';
  if (sub === '/retention') {
    if (read) return 'view_ai_platform';
    if (upper === 'PUT') return 'edit_ai_flags';
    return 'manage_ai_platform';
  }
  if (sub === '/traces') {
    if (read) return 'view_ai_platform';
    if (upper === 'DELETE') return 'edit_ai_flags';
    return 'manage_ai_platform';
  }
  if (/^\/traces\/[^/]+$/.test(sub) && read) return 'view_ai_platform';

  // Prompts
  if (sub === '/prompts/variables' && read) return 'view_prompts';
  if (/^\/prompts\/[^/]+\/[^/]+$/.test(sub) && read) return 'view_prompts';
  if (/^\/prompts\/[^/]+\/[^/]+\/versions\/\d+$/.test(sub) && read) return 'view_prompts';
  if (/^\/prompts\/[^/]+\/[^/]+\/diff$/.test(sub) && read) return 'view_prompts';
  if (/^\/prompts\/[^/]+\/[^/]+\/eval-(?:cases|runs)$/.test(sub) && read) return 'view_prompts';
  if (/^\/prompts\/[^/]+\/[^/]+\/evals\/(?:cases|runs)$/.test(sub) && read) return 'view_prompts';
  if (/^\/prompts\/[^/]+\/[^/]+\/evals\/runs\/\d+$/.test(sub) && read) return 'view_prompts';
  if (/^\/prompts\/[^/]+\/[^/]+\/draft$/.test(sub) && (upper === 'PUT' || upper === 'DELETE')) return 'edit_prompts';
  if (/^\/prompts\/[^/]+\/[^/]+\/(?:preview|try|evaluate)$/.test(sub) && upper === 'POST') return 'edit_prompts';
  if (/^\/prompts\/[^/]+\/[^/]+\/eval-cases$/.test(sub) && upper === 'POST') return 'edit_prompts';
  if (/^\/prompts\/[^/]+\/[^/]+\/eval-cases\/\d+$/.test(sub) && (upper === 'PUT' || upper === 'DELETE')) return 'edit_prompts';
  if (/^\/prompts\/[^/]+\/[^/]+\/evals\/(?:cases|run)$/.test(sub) && upper === 'POST') return 'edit_prompts';
  if (/^\/prompts\/[^/]+\/[^/]+\/evals\/cases\/\d+$/.test(sub) && (upper === 'PUT' || upper === 'DELETE')) return 'edit_prompts';
  if (/^\/prompts\/[^/]+\/[^/]+\/(?:publish|restore)$/.test(sub) && upper === 'POST') return 'publish_prompts';
  if (/^\/prompts\/[^/]+\/[^/]+\/ab$/.test(sub) && upper === 'PUT') return 'publish_prompts';
  if (/^\/prompts\/[^/]+\/[^/]+\/canary$/.test(sub)) {
    if (read) return 'view_prompts';
    if (upper === 'PUT') return 'publish_prompts';
    return 'manage_ai_platform';
  }
  if (/^\/prompts\/[^/]+\/[^/]+\/canary\/(?:promote|abort)$/.test(sub) && upper === 'POST') return 'publish_prompts';

  // Retrieval
  if (sub === '/retrieval/usage' && read) return 'view_retrieval';
  if (/^\/retrieval\/[^/]+\/[^/]+$/.test(sub)) {
    if (read) return 'view_retrieval';
    if (upper === 'PUT') return 'edit_retrieval';
    return 'manage_ai_platform';
  }
  if (/^\/retrieval\/[^/]+\/[^/]+\/reindex$/.test(sub) && upper === 'POST') return 'edit_retrieval';
  if (/^\/retrieval\/[^/]+\/[^/]+\/query$/.test(sub) && upper === 'POST') return 'view_retrieval';

  // Prompt cache
  if (sub === '/prompt-cache/settings') {
    if (read) return 'view_prompt_cache';
    if (upper === 'PUT') return 'edit_prompt_cache';
    return 'manage_ai_platform';
  }
  if (sub === '/prompt-cache/capabilities') {
    if (read) return 'view_prompt_cache';
    if (upper === 'PUT' || upper === 'DELETE') return 'edit_prompt_cache';
    return 'manage_ai_platform';
  }
  if (sub === '/prompt-cache/stats' && read) return 'view_prompt_cache';

  // Semantic cache
  if (/^\/semantic-cache\/[^/]+\/[^/]+\/settings$/.test(sub)) {
    if (read) return 'view_prompt_cache';
    if (upper === 'PUT') return 'edit_prompt_cache';
    return 'manage_ai_platform';
  }
  if (/^\/semantic-cache\/[^/]+\/[^/]+\/stats$/.test(sub) && read) return 'view_prompt_cache';
  if (/^\/semantic-cache\/[^/]+\/[^/]+\/flush$/.test(sub) && upper === 'POST') return 'edit_prompt_cache';
  if (/^\/semantic-cache\/[^/]+\/[^/]+\/lookup-preview$/.test(sub) && upper === 'POST') {
    return 'view_prompt_cache';
  }

  // MCP client
  if (sub === '/mcp/servers') {
    if (read) return 'view_mcp_servers';
    if (upper === 'POST') return 'edit_mcp_servers';
    return 'manage_ai_platform';
  }
  if (/^\/mcp\/servers\/\d+$/.test(sub)) {
    if (upper === 'PATCH' || upper === 'DELETE') return 'edit_mcp_servers';
    return 'manage_ai_platform';
  }
  if (/^\/mcp\/servers\/\d+\/(?:test|sync)$/.test(sub) && upper === 'POST') return 'edit_mcp_servers';
  if (/^\/mcp\/servers\/\d+\/oauth(?:\/status)?$/.test(sub) && read) return 'view_mcp_servers';
  if (/^\/mcp\/servers\/\d+\/oauth$/.test(sub) && upper === 'DELETE') return 'edit_mcp_servers';
  if (
    /^\/mcp\/servers\/\d+\/oauth\/(?:config|discover|start|callback|refresh|revoke)$/.test(sub) &&
    (upper === 'PUT' || upper === 'POST' || read)
  ) {
    return 'edit_mcp_servers';
  }
  if (/^\/mcp\/servers\/\d+\/tools$/.test(sub) && read) return 'view_mcp_servers';
  if (/^\/mcp\/tools\/\d+$/.test(sub) && upper === 'PATCH') return 'review_mcp_tools';
  if (/^\/mcp\/bindings\/[^/]+\/[^/]+$/.test(sub)) {
    if (read) return 'view_mcp_servers';
    if (upper === 'PUT') return 'review_mcp_tools';
    return 'manage_ai_platform';
  }
  if (sub === '/mcp/calls' && read) return 'view_mcp_servers';
  if (sub === '/mcp/allowed-internal-hosts') return 'manage_ai_platform';

  // Output guard
  if (sub === '/output-guard/events' && read) return 'view_output_guard';
  if (/^\/output-guard\/events\/\d+\/excerpt$/.test(sub) && read) return 'view_guard_excerpts';
  if (/^\/output-guard\/[^/]+\/[^/]+$/.test(sub)) {
    if (read) return 'view_output_guard';
    if (upper === 'PUT') return 'edit_output_guard';
    return 'manage_ai_platform';
  }
  if (/^\/output-guard\/[^/]+\/[^/]+\/test$/.test(sub) && upper === 'POST') return 'view_output_guard';
  if (/^\/output-guard\/[^/]+\/[^/]+\/credential-scrub$/.test(sub)) {
    if (read) return 'view_output_guard';
    if (upper === 'PUT') return 'edit_output_guard';
    return 'manage_ai_platform';
  }

  // Orchestrator
  if (sub === '/agents') {
    if (read) return 'view_flows';
    if (upper === 'POST') return 'edit_flows';
    return 'manage_ai_platform';
  }
  if (/^\/agents\/\d+$/.test(sub)) {
    if (read) return 'view_flows';
    if (upper === 'PATCH' || upper === 'DELETE') return 'edit_flows';
    return 'manage_ai_platform';
  }
  if (sub === '/flows') {
    if (read) return 'view_flows';
    if (upper === 'POST') return 'edit_flows';
    return 'manage_ai_platform';
  }
  if (/^\/flows\/\d+$/.test(sub)) {
    if (read) return 'view_flows';
    if (upper === 'DELETE') return 'edit_flows';
    return 'manage_ai_platform';
  }
  if (/^\/flows\/\d+\/(?:draft|try)$/.test(sub) && (upper === 'PUT' || upper === 'POST')) {
    if (sub.endsWith('/draft') && upper === 'PUT') return 'edit_flows';
    if (sub.endsWith('/try') && upper === 'POST') return 'edit_flows';
    return 'manage_ai_platform';
  }
  if (/^\/flows\/\d+\/publish$/.test(sub) && upper === 'POST') return 'publish_flows';
  if (/^\/flows\/\d+\/grants$/.test(sub) && upper === 'PUT') return 'publish_flows';
  if (/^\/flows\/\d+\/runs\/async$/.test(sub) && upper === 'POST') return 'edit_flows';
  if (/^\/flows\/\d+\/schedule$/.test(sub)) {
    if (read) return 'view_flows';
    if (upper === 'PUT' || upper === 'DELETE') return 'edit_flows';
    return 'manage_ai_platform';
  }
  if (/^\/flows\/\d+\/schedule\/tick$/.test(sub) && upper === 'POST') return 'edit_flows';
  if (sub === '/runs' && read) return 'view_flow_runs';
  if (/^\/runs\/[^/]+$/.test(sub) && read) return 'view_flow_runs';
  if (/^\/runs\/[^/]+\/cancel$/.test(sub) && upper === 'POST') return 'cancel_flow_runs';
  if (sub === '/approvals' && read) return 'approve_ai_actions';
  if (/^\/approvals\/\d+\/(?:approve|reject)$/.test(sub) && upper === 'POST') return 'approve_ai_actions';
  if (/^\/(?:mcp\/)?approvals\/\d+\/continuation$/.test(sub) && read) return 'approve_ai_actions';

  // Customer AI Hub (Admin Assistants Studio & Fleet Anomaly Radar)
  if (sub === '/customer-assistants') {
    if (read) return 'view_prompts';
    if (upper === 'POST') return 'edit_prompts';
    return 'manage_ai_platform';
  }
  if (/^\/customer-assistants\/\d+$/.test(sub) && (upper === 'PATCH' || upper === 'DELETE')) {
    return 'edit_prompts';
  }
  if (sub === '/anomaly-radar' && read) return 'view_ai_platform';
  if (/^\/anomaly-radar\/users\/\d+\/apply-eco$/.test(sub) && upper === 'POST') return 'edit_ai_flags';

  return 'manage_ai_platform';
}
