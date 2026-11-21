/**
 * Grounded guide answers for callers outside the tenant-setup pipeline
 * (members without tenant access, the System target). Instead of a canned
 * script they get the same agent loop the tenant flow uses — retrieved
 * knowledge in the prompt plus the read-only lookup tools — and fall back to
 * the deterministic reply only when no model route answers.
 */
import type {
  SupportSetupChatMessage,
  SupportSetupChatResponse,
} from '@freellmapi/shared/support-setup-copilot.js';
import type { SessionUser } from '../../services/auth.js';
import { runCopilotAgentLoop, type CopilotLlmCall } from './agent-loop.js';
import { resolveCopilotUserScope } from './diagnostics.js';
import { buildCallerIdentity } from './identity.js';
import type { GatewayLoopbackContext } from './llm-coach.js';
import { looksLikeQuestionnaire } from './playbook.js';

export async function tryGroundedGuideReply(params: {
  user: SessionUser;
  messages: SupportSetupChatMessage[];
  locale: 'vi' | 'en';
  currentPath?: string;
  gatewayLoopback?: GatewayLoopbackContext;
  /** Quick replies used when the model supplies none. */
  fallbackQuickReplies?: string[];
  /** Extra trusted instructions for the model (scope rules). */
  extraInstructions?: string;
  /** Inject a fake LLM turn (unit tests). */
  llmCall?: CopilotLlmCall;
}): Promise<SupportSetupChatResponse | null> {
  const { user, messages, locale, currentPath, gatewayLoopback } = params;
  try {
    const scope = resolveCopilotUserScope(user);
    const loop = await runCopilotAgentLoop({
      user,
      scope,
      agentContext: buildCallerIdentity(user, scope),
      messages,
      locale,
      targetMode: 'update_tenant',
      tenantId: null,
      currentPath,
      diagnostic: null,
      extracted: {},
      canCreateTenant: false,
      canEditSteps: new Set(),
      gatewayLoopback,
      ...(params.extraInstructions ? { extraInstructions: params.extraInstructions } : {}),
      ...(params.llmCall ? { llmCall: params.llmCall } : {}),
    });
    const out = loop.output;
    if (!out?.reply || (out.intent && out.intent !== 'guide') || looksLikeQuestionnaire(out.reply)) return null;
    return {
      ok: true,
      replyLocale: locale,
      reply: out.reply,
      intent: 'guide',
      missingQuestions: [],
      suggestedQuickReplies: out.suggestedQuickReplies?.length
        ? out.suggestedQuickReplies.slice(0, 4)
        : params.fallbackQuickReplies ?? [],
      proposal: null,
      userDiagnostic: null,
      actionProposal: null,
      modelUsed: loop.modelUsed,
      usedFallback: false,
    };
  } catch {
    return null;
  }
}
