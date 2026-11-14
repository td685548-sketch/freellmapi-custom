import type { Request } from 'express';
import type { Scope } from '@freellmapi/shared/ai-platform.js';
import {
  MCP_LIMITS,
  type McpTakeoverPlan,
} from '@freellmapi/shared/ai-platform-mcp.js';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import type { GateProfile } from '../../../services/profile-usage.js';
import { isPillarEnabled } from '../flags.js';
import { isInternalCall } from '../loopback.js';
import { detectWire } from '../wire/detect.js';
import { requestedModel } from '../wire/extract.js';
import { toolsForScope } from './bindings.js';
import {
  extractCallerToolsOrNull,
  extractLoopParamsOrNull,
  toLoopbackMessages,
  type LoopSafeParams,
} from './messages.js';

export interface PreparedMcpTakeover {
  plan: McpTakeoverPlan;
  messages: ChatMessage[];
  params: LoopSafeParams;
  endUser: string | null;
}

const preparedPlans = new WeakMap<Request, PreparedMcpTakeover>();

/**
 * Decides BEFORE outer quota/RPM admission whether an incoming `/v1` or `/v1beta`
 * request will be taken over by the MCP server-side tool loop.
 *
 * Returns `null` (falling back to the normal gateway path + normal quota admission)
 * whenever the pillar is off, the call is an internal loopback subcall, the profile
 * has MCP tools disabled, `x-freellm-tools: off` is set, no effective tools are bound,
 * or the request body cannot be safely converted without information loss.
 */
export function prepareMcpTakeover(
  req: Request,
  profile: GateProfile,
  endUser: string | null,
): McpTakeoverPlan | null {
  if (!isPillarEnabled('mcpClient')) return null;
  if (isInternalCall(req) !== null) return null;
  if (!profile.aiToolsEnabled) return null;

  const toolsHeader = req.headers['x-freellm-tools'];
  const headerVal = Array.isArray(toolsHeader) ? toolsHeader[0] : toolsHeader;
  if (typeof headerVal === 'string' && headerVal.trim().toLowerCase() === 'off') {
    return null;
  }

  const detected = detectWire(req);
  if (!detected) return null;

  const messages = toLoopbackMessages(detected.wire, req.body);
  if (!messages) return null;

  const callerTools = extractCallerToolsOrNull(detected.wire, req.body);
  if (!callerTools) return null;

  const params = extractLoopParamsOrNull(detected.wire, req.body);
  if (!params) return null;

  const scope: Scope = { kind: 'profile', id: String(profile.id) };

  let tools;
  try {
    tools = toolsForScope(scope, callerTools);
  } catch {
    return null;
  }
  if (tools.length === 0) return null;

  const model = requestedModel(detected.wire, req);
  if (!model) return null;

  const maxRounds = Math.max(
    MCP_LIMITS.minRounds,
    Math.min(MCP_LIMITS.maxRounds, profile.aiToolMaxRounds ?? MCP_LIMITS.defaultMaxRounds),
  );

  const plan: McpTakeoverPlan = {
    scope,
    maxRounds,
    tools,
    callerTools,
    wire: detected.wire,
    stream: detected.stream,
    model,
  };

  preparedPlans.set(req, { plan, messages, params, endUser });
  return plan;
}

/** Refreshes canonical messages after outer knowledge enrichment. */
export function refreshMcpTakeoverMessages(req: Request): void {
  const prepared = preparedPlans.get(req);
  if (!prepared) return;
  const refreshed = toLoopbackMessages(prepared.plan.wire, req.body);
  if (refreshed) {
    prepared.messages = refreshed;
  }
}

/** Consumes the private per-request takeover plan prepared before quota admission. */
export function consumeMcpTakeoverPlan(req: Request): PreparedMcpTakeover | null {
  const prepared = preparedPlans.get(req) ?? null;
  if (prepared) preparedPlans.delete(req);
  return prepared;
}
