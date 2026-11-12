import crypto from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import type { SessionUser } from '../../services/auth.js';
import {
  SupportStoreError,
  type SupportTenant,
  type SupportUserContext,
  listSupportTenants,
  getSupportTenant,
  getSupportTenantByPublicKey,
  getSupportTenantSigningSecret,
  createSupportTenant,
  updateSupportTenant,
  deleteSupportTenant,
  rotateSupportTenantSecret,
  listSupportTools,
  getSupportTool,
  createSupportTool,
  updateSupportTool,
  deleteSupportTool,
  listSupportDbSources,
  getSupportDbSource,
  getSupportDbSourceAuthToken,
  createSupportDbSource,
  updateSupportDbSource,
  deleteSupportDbSource,
  mintSupportUserToken,
  verifySupportUserToken,
} from './support-store.js';
import {
  SupportConnectorError,
  type SupportAvailableToolDescriptor,
  DEFAULT_ECOMMERCE_SANDBOX_SQL,
  DEFAULT_ECOMMERCE_TABLE_POLICIES,
  buildAllowedToolsForContext,
  executeSupportWebhookTool,
  executeSupportDbQuery,
} from './support-connectors.js';
import { resolveCandidateRoutes } from './router.js';
import { resolveAccountProvider } from '../provider-accounts/execution.js';
import { decrypt } from '../../lib/crypto.js';
import { resolveXGatewayAccountProxy } from '../provider-accounts/store.js';
import { withQuotaTracking } from './quota/tracking.js';
import { estimateInputTokens } from '../../lib/content.js';

// ---------------------------------------------------------------------------
// Shared Types
// ---------------------------------------------------------------------------

export interface SupportToolTraceEntry {
  kind: 'webhook' | 'db';
  name: string;
  toolName?: string;
  args?: Record<string, unknown>;
  rewrittenSql?: string;
  result?: unknown;
  output?: unknown;
  error?: string;
  durationMs?: number;
}

export interface SupportChatCompletionResult {
  reply: string;
  userContext: SupportUserContext;
  allowedTools: SupportAvailableToolDescriptor[];
  toolTrace: SupportToolTraceEntry[];
  modelUsed: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ---------------------------------------------------------------------------
// Tenant Resolution Helper
// ---------------------------------------------------------------------------

export function resolveTenant(tenantKeyOrSlug: string): SupportTenant {
  const trimmed = String(tenantKeyOrSlug ?? '').trim();
  if (!trimmed) {
    throw new SupportStoreError(400, 'Tenant key or slug is required.');
  }
  if (trimmed.startsWith('pk_sup_')) {
    try {
      return getSupportTenantByPublicKey(trimmed);
    } catch {
      /* continue to fallback lookup */
    }
  }
  const all = listSupportTenants();
  const matched = all.find(
    (t) => t.slug === trimmed || t.publicKey === trimmed || String(t.id) === trimmed,
  );
  if (!matched) {
    throw new SupportStoreError(404, `Support tenant '${trimmed}' not found.`);
  }
  return matched;
}

// ---------------------------------------------------------------------------
// CORS Helper
// ---------------------------------------------------------------------------

function applySupportCors(req: Request, res: Response, tenant?: SupportTenant): void {
  const origin = req.headers.origin;
  if (!origin) return;

  const allowedOrigins = tenant?.allowedOrigins ?? [];
  const isAllowed =
    allowedOrigins.length === 0 ||
    allowedOrigins.includes('*') ||
    allowedOrigins.includes(origin);

  if (isAllowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Tenant-Secret, X-Support-Tenant-Key, X-Support-Context-Token',
  );
}

// ---------------------------------------------------------------------------
// Core Agentic Support Chat & Tool-Calling Pipeline
// ---------------------------------------------------------------------------

export async function executeSupportChatPipeline(options: {
  tenant: SupportTenant;
  userContext: SupportUserContext;
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  model?: string;
}): Promise<SupportChatCompletionResult> {
  const { tenant, userContext, messages } = options;
  const tools = listSupportTools(tenant.id);
  const dbSources = listSupportDbSources(tenant.id);
  const allowedTools = buildAllowedToolsForContext(userContext, tools, dbSources);

  const toolTrace: SupportToolTraceEntry[] = [];
  const modelUsed = options.model?.trim() || tenant.defaultModel || 'auto';

  // Tool execution helper
  const invokeTool = async (
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ output: unknown; rewrittenSql?: string; error?: string; kind: 'webhook' | 'db' }> => {
    const started = Date.now();
    const descriptor = allowedTools.find(
      (t) =>
        t.functionName === toolName ||
        t.displayName === toolName ||
        t.functionName.toLowerCase() === toolName.toLowerCase() ||
        t.displayName.toLowerCase() === toolName.toLowerCase(),
    );

    if (!descriptor) {
      const err = `Tool "${toolName}" is not available or not permitted for role "${userContext.role}".`;
      toolTrace.push({
        kind: 'webhook',
        name: toolName,
        toolName,
        args,
        error: err,
        durationMs: Date.now() - started,
      });
      return { output: null, error: err, kind: 'webhook' };
    }

    if (descriptor.kind === 'webhook') {
      const webhook = tools.find((w) => w.id === descriptor.id);
      if (!webhook) {
        const err = `Webhook tool #${descriptor.id} not found.`;
        toolTrace.push({
          kind: 'webhook',
          name: descriptor.functionName,
          toolName: descriptor.functionName,
          args,
          error: err,
          durationMs: Date.now() - started,
        });
        return { output: null, error: err, kind: 'webhook' };
      }
      try {
        const res = await executeSupportWebhookTool({
          tool: webhook,
          context: userContext,
          args,
          signingSecret: getSupportTenantSigningSecret(tenant.id),
        });
        toolTrace.push({
          kind: 'webhook',
          name: descriptor.functionName,
          toolName: descriptor.functionName,
          args: res.effectiveArgs,
          result: res.data,
          output: res.data,
          durationMs: Date.now() - started,
        });
        return { output: res.data, kind: 'webhook' };
      } catch (err) {
        const errorMsg = (err as Error).message;
        toolTrace.push({
          kind: 'webhook',
          name: descriptor.functionName,
          toolName: descriptor.functionName,
          args,
          error: errorMsg,
          durationMs: Date.now() - started,
        });
        return { output: null, error: errorMsg, kind: 'webhook' };
      }
    } else {
      // Database tool
      const dbSource = dbSources.find((d) => d.id === descriptor.id);
      if (!dbSource) {
        const err = `Database source #${descriptor.id} not found.`;
        toolTrace.push({
          kind: 'db',
          name: descriptor.functionName,
          toolName: descriptor.functionName,
          args,
          error: err,
          durationMs: Date.now() - started,
        });
        return { output: null, error: err, kind: 'db' };
      }
      const sql = typeof args.sql === 'string' ? args.sql : '';
      try {
        const authToken = getSupportDbSourceAuthToken(tenant.id, dbSource.id);
        const res = await executeSupportDbQuery({
          source: dbSource,
          context: userContext,
          sql,
          authToken,
        });
        toolTrace.push({
          kind: 'db',
          name: descriptor.functionName,
          toolName: descriptor.functionName,
          args,
          rewrittenSql: res.rewrittenSql,
          result: res.rows,
          output: res.rows,
          durationMs: Date.now() - started,
        });
        return { output: res.rows, rewrittenSql: res.rewrittenSql, kind: 'db' };
      } catch (err) {
        const errorMsg = (err as Error).message;
        toolTrace.push({
          kind: 'db',
          name: descriptor.functionName,
          toolName: descriptor.functionName,
          args,
          error: errorMsg,
          durationMs: Date.now() - started,
        });
        return { output: null, error: errorMsg, kind: 'db' };
      }
    }
  };

  // System Prompt Builder
  const toolDescriptions = allowedTools
    .map((t) => {
      return `- Tool: ${t.functionName} (${t.displayName}, ${t.kind})\n  Description: ${t.description}\n  Parameters: ${JSON.stringify(t.parameters)}`;
    })
    .join('\n\n');

  const systemPrompt = [
    tenant.systemPrompt?.trim() || 'You are an AI Support Assistant for this organization.',
    '',
    '--- CUSTOMER IDENTITY & RBAC CONTEXT ---',
    `User ID: ${userContext.userId}`,
    `Name: ${userContext.name || 'Anonymous'}`,
    `Role: ${userContext.role}`,
    `Verified: ${userContext.verified ? 'true' : 'false'}`,
    `Permissions: ${userContext.permissions.join(', ') || 'none'}`,
    '',
    '--- AVAILABLE TOOLS ---',
    allowedTools.length > 0
      ? `You have access to the following tools matching the customer's role:\n${toolDescriptions}\n\nTo execute a tool call, output inside your response:\n<support_tool_call>{"name": "FUNCTION_NAME", "arguments": {...}}</support_tool_call>`
      : 'No tools or database access are available for the customer role. Answer politely based on general information.',
  ].join('\n');

  // Attempt real LLM via X-Gateway candidate routes if usable accounts are present
  let reply = '';
  let promptTokens = estimateInputTokens(messages) + 150;
  let completionTokens = 0;
  let executedViaLlm = false;

  try {
    const { candidates } = resolveCandidateRoutes(modelUsed, 'chat');
    if (candidates && candidates.length > 0) {
      const turnMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        { role: 'system', content: systemPrompt },
        ...messages.map((m) => ({
          role: m.role as 'user' | 'assistant' | 'system',
          content: m.content,
        })),
      ];

      for (let turn = 0; turn < 3; turn++) {
        let completionText = '';
        let matched = false;

        for (const candidate of candidates) {
          const { account, modelId } = candidate;
          const provider = resolveAccountProvider(account);
          if (!provider) continue;

          try {
            const credential = decrypt(account.encrypted_key, account.iv, account.auth_tag);
            const proxy = resolveXGatewayAccountProxy(account);
            const res = await withQuotaTracking(account, modelId, proxy, () =>
              provider.chatCompletion(
                credential,
                turnMessages,
                modelId,
                { temperature: 0.2 },
                { platform: account.platform, keyId: account.id, modelId },
              ),
            );

            const rawContent = res.choices?.[0]?.message?.content;
            completionText =
              typeof rawContent === 'string'
                ? rawContent
                : Array.isArray(rawContent)
                  ? rawContent
                      .map((b) =>
                        typeof b === 'string'
                          ? b
                          : typeof b === 'object' && b !== null && 'text' in b && typeof b.text === 'string'
                            ? b.text
                            : '',
                      )
                      .join('')
                  : '';
            if (res.usage) {
              promptTokens = res.usage.prompt_tokens ?? promptTokens;
              completionTokens += res.usage.completion_tokens ?? 0;
            }
            matched = true;
            break;
          } catch {
            /* Try next candidate */
          }
        }

        if (!matched) break;

        // Check if completion contains tool call tags
        const toolCallRegex = /<support_tool_call>\s*({[\s\S]*?})\s*<\/support_tool_call>/gi;
        const matches = [...completionText.matchAll(toolCallRegex)];

        if (matches.length === 0) {
          reply = completionText.trim();
          executedViaLlm = true;
          break;
        }

        // Execute all requested tool calls
        let toolResultsText = '';
        for (const match of matches) {
          try {
            const parsed = JSON.parse(match[1]) as { name: string; arguments?: Record<string, unknown> };
            const toolRes = await invokeTool(parsed.name, parsed.arguments ?? {});
            toolResultsText += `\n<support_tool_result name="${parsed.name}">\n${JSON.stringify(toolRes.output ?? { error: toolRes.error })}\n</support_tool_result>`;
          } catch (parseErr) {
            toolResultsText += `\n<support_tool_result error="Invalid tool call JSON: ${(parseErr as Error).message}" />`;
          }
        }

        turnMessages.push({ role: 'assistant', content: completionText });
        turnMessages.push({
          role: 'user',
          content: `Tool Execution Results:\n${toolResultsText}\nPlease respond to the user based on these results.`,
        });
      }
    }
  } catch {
    /* Fall through to deterministic fallback */
  }

  // Smart Built-in Deterministic Fallback
  if (!executedViaLlm || !reply) {
    const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
    const textLower = lastUserMessage.toLowerCase();

    // Check if the user message itself contained an explicit <support_tool_call>
    const directToolRegex = /<support_tool_call>\s*({[\s\S]*?})\s*<\/support_tool_call>/i;
    const directMatch = directToolRegex.exec(lastUserMessage);

    if (directMatch) {
      try {
        const parsed = JSON.parse(directMatch[1]) as { name: string; arguments?: Record<string, unknown> };
        const toolRes = await invokeTool(parsed.name, parsed.arguments ?? {});
        reply = `Executed tool "${parsed.name}": ${JSON.stringify(toolRes.output ?? { error: toolRes.error })}`;
      } catch (err) {
        reply = `Failed to parse tool call: ${(err as Error).message}`;
      }
    } else if (/\b(order|orders|đơn hàng|tracking|trk-)\b/i.test(textLower)) {
      // Orders query
      const dbTool = allowedTools.find((t) => t.kind === 'db');
      if (dbTool) {
        const res = await invokeTool(dbTool.functionName, { sql: 'SELECT * FROM orders' });
        if (res.error) {
          reply = `I cannot access orders because ${res.error}. Please sign in with an authorized account.`;
        } else {
          const rows = Array.isArray(res.output) ? (res.output as Record<string, unknown>[]) : [];
          if (rows.length > 0) {
            const list = rows
              .map(
                (r) =>
                  `- Order #${r.id}: ${r.product_name} (Status: ${r.status}, Total: $${r.total_usd}${r.tracking_code ? `, Tracking: ${r.tracking_code}` : ''})`,
              )
              .join('\n');
            reply = `Here are the orders found for your account (${userContext.userId}):\n${list}`;
          } else {
            reply = `No orders were found for user "${userContext.userId}".`;
          }
        }
      } else {
        reply = `I cannot access orders because your role (${userContext.role}) does not have permission to view order history. Please sign in with an authorized account.`;
      }
    } else if (/\b(product|products|sản phẩm|catalog|mouse|keyboard|monitor|hub|price)\b/i.test(textLower)) {
      // Products query
      const dbTool = allowedTools.find((t) => t.kind === 'db');
      if (dbTool) {
        const res = await invokeTool(dbTool.functionName, { sql: 'SELECT * FROM products' });
        if (res.error) {
          reply = `I cannot access products because ${res.error}.`;
        } else {
          const rows = Array.isArray(res.output) ? (res.output as Record<string, unknown>[]) : [];
          if (rows.length > 0) {
            const list = rows
              .map(
                (r) =>
                  `- ${r.name} (${r.category}): $${r.price} (Stock: ${r.stock})`,
              )
              .join('\n');
            reply = `Here are our available products:\n${list}`;
          } else {
            reply = 'No products are currently available in the catalog.';
          }
        }
      } else {
        reply = 'Product catalog is currently unavailable.';
      }
    } else if (/\b(customer|customers|khách hàng|profile|account|tier)\b/i.test(textLower)) {
      // Customers query
      const dbTool = allowedTools.find((t) => t.kind === 'db');
      if (dbTool) {
        const res = await invokeTool(dbTool.functionName, { sql: 'SELECT * FROM customers' });
        if (res.error) {
          reply = `Access to customer profile records is restricted: ${res.error}.`;
        } else {
          const rows = Array.isArray(res.output) ? (res.output as Record<string, unknown>[]) : [];
          if (rows.length > 0) {
            const list = rows
              .map((r) => `- Customer: ${r.name} (${r.email}, Tier: ${r.tier})`)
              .join('\n');
            reply = `Customer profile details:\n${list}`;
          } else {
            reply = 'No customer profile found.';
          }
        }
      } else {
        reply = `Access to customer profile records is restricted for role "${userContext.role}".`;
      }
    } else {
      // Check if user specifically requested a webhook tool by name
      const matchingWebhook = allowedTools.find(
        (t) => t.kind === 'webhook' && textLower.includes(t.displayName.toLowerCase()),
      );
      if (matchingWebhook) {
        const res = await invokeTool(matchingWebhook.functionName, {});
        reply = `Executed webhook tool "${matchingWebhook.displayName}": ${JSON.stringify(res.output ?? { error: res.error })}`;
      } else {
        const namePart = userContext.name ? ` ${userContext.name}` : '';
        reply = `Hello${namePart}! I am your AI Support Assistant. As a ${userContext.role}, how can I help you today? You can ask about our products, check your orders, or ask general questions.`;
      }
    }
  }

  completionTokens = Math.max(completionTokens, Math.ceil(reply.length / 4));

  return {
    reply,
    userContext,
    allowedTools,
    toolTrace,
    modelUsed,
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Console Management Router (/api/x-gateway/support/*)
// ---------------------------------------------------------------------------

export const xSupportConsoleRouter = Router();

// GET /tenants
xSupportConsoleRouter.get('/tenants', (_req: Request, res: Response) => {
  const tenants = listSupportTenants();
  res.json({ tenants, sampleSchemaSql: DEFAULT_ECOMMERCE_SANDBOX_SQL });
});

// POST /tenants
xSupportConsoleRouter.post('/tenants', (req: Request, res: Response) => {
  const { seedSampleDb, ...tenantInput } = req.body ?? {};
  const uid = (req as Request & { user?: SessionUser }).user?.userId ?? null;
  const { tenant, signingSecret } = createSupportTenant({
    ...tenantInput,
    createdBy: uid,
  });

  if (seedSampleDb !== false) {
    try {
      createSupportDbSource(tenant.id, {
        name: 'Sample Store DB',
        driver: 'sqlite-sandbox',
        schemaSql: DEFAULT_ECOMMERCE_SANDBOX_SQL,
        tablePolicies: DEFAULT_ECOMMERCE_TABLE_POLICIES,
        maxRows: 50,
        enabled: true,
      });
    } catch {
      /* ignore sample db seed failure */
    }
  }

  res.status(201).json({ tenant, signingSecret });
});

// GET /tenants/:id
xSupportConsoleRouter.get('/tenants/:id', (req: Request, res: Response) => {
  const tenant = getSupportTenant(Number(req.params.id));
  res.json({ tenant });
});

// PATCH /tenants/:id
xSupportConsoleRouter.patch('/tenants/:id', (req: Request, res: Response) => {
  const tenant = updateSupportTenant(Number(req.params.id), req.body ?? {});
  res.json({ tenant });
});

// DELETE /tenants/:id
xSupportConsoleRouter.delete('/tenants/:id', (req: Request, res: Response) => {
  deleteSupportTenant(Number(req.params.id));
  res.json({ ok: true });
});

// POST /tenants/:id/rotate-secret
xSupportConsoleRouter.post('/tenants/:id/rotate-secret', (req: Request, res: Response) => {
  const { tenant, signingSecret } = rotateSupportTenantSecret(Number(req.params.id));
  res.json({ tenant, signingSecret });
});

// GET /tenants/:id/tools
xSupportConsoleRouter.get('/tenants/:id/tools', (req: Request, res: Response) => {
  const tools = listSupportTools(Number(req.params.id));
  res.json({ tools });
});

// POST /tenants/:id/tools
xSupportConsoleRouter.post('/tenants/:id/tools', (req: Request, res: Response) => {
  const tool = createSupportTool(Number(req.params.id), req.body ?? {});
  res.status(201).json({ tool });
});

// PATCH /tenants/:id/tools/:toolId
xSupportConsoleRouter.patch('/tenants/:id/tools/:toolId', (req: Request, res: Response) => {
  const tool = updateSupportTool(Number(req.params.id), Number(req.params.toolId), req.body ?? {});
  res.json({ tool });
});

// DELETE /tenants/:id/tools/:toolId
xSupportConsoleRouter.delete('/tenants/:id/tools/:toolId', (req: Request, res: Response) => {
  deleteSupportTool(Number(req.params.id), Number(req.params.toolId));
  res.json({ ok: true });
});

// POST /tenants/:id/tools/:toolId/test
xSupportConsoleRouter.post('/tenants/:id/tools/:toolId/test', async (req: Request, res: Response) => {
  const tenantId = Number(req.params.id);
  const tool = getSupportTool(tenantId, Number(req.params.toolId));
  const signingSecret = getSupportTenantSigningSecret(tenantId);
  const context: SupportUserContext = {
    tenantId,
    userId: String(req.body.userId || 'test-user'),
    role: String(req.body.role || 'customer'),
    name: req.body.name ? String(req.body.name) : undefined,
    permissions: [],
    verified: true,
  };
  const result = await executeSupportWebhookTool({
    tool,
    context,
    args: (req.body.args as Record<string, unknown>) ?? {},
    signingSecret,
  });
  res.json(result);
});

// GET /tenants/:id/db-sources
xSupportConsoleRouter.get('/tenants/:id/db-sources', (req: Request, res: Response) => {
  const dbSources = listSupportDbSources(Number(req.params.id));
  res.json({ dbSources });
});

// POST /tenants/:id/db-sources
xSupportConsoleRouter.post('/tenants/:id/db-sources', (req: Request, res: Response) => {
  const dbSource = createSupportDbSource(Number(req.params.id), req.body ?? {});
  res.status(201).json({ dbSource });
});

// PATCH /tenants/:id/db-sources/:sourceId
xSupportConsoleRouter.patch('/tenants/:id/db-sources/:sourceId', (req: Request, res: Response) => {
  const dbSource = updateSupportDbSource(
    Number(req.params.id),
    Number(req.params.sourceId),
    req.body ?? {},
  );
  res.json({ dbSource });
});

// DELETE /tenants/:id/db-sources/:sourceId
xSupportConsoleRouter.delete('/tenants/:id/db-sources/:sourceId', (req: Request, res: Response) => {
  deleteSupportDbSource(Number(req.params.id), Number(req.params.sourceId));
  res.json({ ok: true });
});

// POST /tenants/:id/db-sources/:sourceId/query-test
xSupportConsoleRouter.post(
  '/tenants/:id/db-sources/:sourceId/query-test',
  async (req: Request, res: Response) => {
    const tenantId = Number(req.params.id);
    const source = getSupportDbSource(tenantId, Number(req.params.sourceId));
    const authToken = getSupportDbSourceAuthToken(tenantId, source.id);
    const context: SupportUserContext = {
      tenantId,
      userId: String(req.body.userId || 'guest'),
      role: String(req.body.role || 'guest'),
      name: req.body.name ? String(req.body.name) : undefined,
      permissions: [],
      verified: true,
    };
    const result = await executeSupportDbQuery({
      source,
      context,
      sql: String(req.body.sql || ''),
      authToken,
    });
    res.json({ ok: true, ...result });
  },
);

// POST /tenants/:id/mint-token
xSupportConsoleRouter.post('/tenants/:id/mint-token', (req: Request, res: Response) => {
  const tenantId = Number(req.params.id);
  const token = mintSupportUserToken(tenantId, req.body ?? {});
  const context = verifySupportUserToken(tenantId, token);
  res.json({ token, context });
});

// POST /tenants/:id/simulate-chat
xSupportConsoleRouter.post('/tenants/:id/simulate-chat', async (req: Request, res: Response) => {
  const tenantId = Number(req.params.id);
  const tenant = getSupportTenant(tenantId);
  const role = String(req.body.role || 'guest');
  const roleCfg = tenant.rolesConfig.find((r) => r.role === role);
  const extraPerms = Array.isArray(req.body.permissions) ? (req.body.permissions as string[]) : [];

  const context: SupportUserContext = {
    tenantId,
    userId: String(req.body.userId || 'guest'),
    name: req.body.name ? String(req.body.name) : undefined,
    role,
    permissions: [...new Set([...(roleCfg?.permissions ?? []), ...extraPerms])],
    verified: true,
  };

  const messages = Array.isArray(req.body.messages)
    ? (req.body.messages as Array<{ role: 'user' | 'assistant' | 'system'; content: string }>)
    : [];

  const result = await executeSupportChatPipeline({
    tenant,
    userContext: context,
    messages,
    model: req.body.model ? String(req.body.model) : undefined,
  });

  res.json({
    reply: result.reply,
    userContext: result.userContext,
    allowedTools: result.allowedTools,
    toolTrace: result.toolTrace,
    modelUsed: result.modelUsed,
    usage: result.usage,
  });
});

// Error handling middleware for Console API
xSupportConsoleRouter.use(
  (err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    if (err instanceof SupportStoreError || err instanceof SupportConnectorError) {
      res.status(err.status).json({ error: { message: err.message, status: err.status } });
      return;
    }
    const message = err instanceof Error ? err.message : 'Support console operation failed.';
    res.status(500).json({ error: { message, status: 500 } });
  },
);

// ---------------------------------------------------------------------------
// 2. Public Partner Gateway Router (/x/v1/support/*)
// ---------------------------------------------------------------------------

export const xSupportPublicRouter = Router();

// CORS Preflight & Handling
xSupportPublicRouter.use((req: Request, res: Response, next: NextFunction): void => {
  if (req.method === 'OPTIONS') {
    const tenantKey =
      (req.headers['x-support-tenant-key'] as string) || (req.query.tenantKey as string);
    let tenant: SupportTenant | undefined;
    if (tenantKey) {
      try {
        tenant = resolveTenant(tenantKey);
      } catch {
        /* ignore */
      }
    }
    applySupportCors(req, res, tenant);
    res.status(204).end();
    return;
  }
  next();
});

// POST /session
xSupportPublicRouter.post('/session', (req: Request, res: Response): void => {
  const tenantKey = req.body?.tenantKey || (req.headers['x-support-tenant-key'] as string);
  if (!tenantKey) {
    res.status(400).json({ error: { message: 'Tenant key is required.' } });
    return;
  }
  const tenant = resolveTenant(tenantKey);
  applySupportCors(req, res, tenant);

  if (!tenant.enabled) {
    res.status(403).json({ error: { message: 'Support tenant is disabled.' } });
    return;
  }

  const authHeader = req.headers.authorization;
  let secret = req.headers['x-tenant-secret'] as string | undefined;
  if (!secret && authHeader && authHeader.startsWith('Bearer ')) {
    secret = authHeader.slice(7).trim();
  }
  if (!secret) {
    res.status(401).json({ error: { message: 'Partner signing secret is required.' } });
    return;
  }

  const expectedSecret = getSupportTenantSigningSecret(tenant.id);
  const bufExpected = Buffer.from(expectedSecret);
  const bufActual = Buffer.from(secret);

  if (
    bufExpected.length !== bufActual.length ||
    !crypto.timingSafeEqual(bufExpected, bufActual)
  ) {
    res.status(401).json({ error: { message: 'Invalid partner signing secret.' } });
    return;
  }

  const ttlSeconds = typeof req.body?.ttlSeconds === 'number' ? req.body.ttlSeconds : 3600;
  const contextToken = mintSupportUserToken(tenant.id, {
    userId: String(req.body?.userId ?? 'guest'),
    name: req.body?.name ? String(req.body.name) : undefined,
    email: req.body?.email ? String(req.body.email) : undefined,
    role: String(req.body?.role ?? 'guest'),
    permissions: Array.isArray(req.body?.permissions) ? (req.body.permissions as string[]) : [],
    metadata: req.body?.metadata as Record<string, unknown> | undefined,
    ttlSeconds,
  });

  const userContext = verifySupportUserToken(tenant.id, contextToken);
  res.json({
    ok: true,
    contextToken,
    expiresIn: ttlSeconds,
    userContext,
  });
});

// POST /chat
xSupportPublicRouter.post('/chat', async (req: Request, res: Response): Promise<void> => {
  const tenantKey =
    req.body?.tenantKey || (req.headers['x-support-tenant-key'] as string | undefined);
  if (!tenantKey) {
    res.status(400).json({ error: { message: 'Tenant key is required.' } });
    return;
  }

  const tenant = resolveTenant(tenantKey);
  applySupportCors(req, res, tenant);

  if (!tenant.enabled) {
    res.status(403).json({ error: { message: 'Support tenant is disabled.' } });
    return;
  }

  const contextToken =
    req.body?.contextToken || (req.headers['x-support-context-token'] as string | undefined);
  const userContext = verifySupportUserToken(tenant.id, contextToken);

  const rawMessages = req.body?.messages;
  const messages = Array.isArray(rawMessages)
    ? (rawMessages as Array<{ role: 'user' | 'assistant' | 'system'; content: string }>)
    : [];

  const model = req.body?.model ? String(req.body.model) : undefined;
  const result = await executeSupportChatPipeline({
    tenant,
    userContext,
    messages,
    model,
  });

  res.json({
    object: 'support.chat.completion',
    tenant: tenant.slug,
    model: result.modelUsed,
    userContext: result.userContext,
    allowedTools: result.allowedTools,
    toolTrace: result.toolTrace,
    reply: result.reply,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: result.reply },
        finish_reason: 'stop',
      },
    ],
    usage: result.usage,
  });
});

// GET /widget.js
xSupportPublicRouter.get('/widget.js', (_req: Request, res: Response) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.type('application/javascript; charset=utf-8');

  const script = `/** FreeLLMAPI AI Support Embeddable Widget */
(function(window, document) {
  'use strict';
  window.FreeLLMAPISupport = {
    init: function(config) {
      if (!config || !config.tenantKey) {
        console.error('[FreeLLMAPI Support] Missing required tenantKey');
        return null;
      }
      var tenantKey = config.tenantKey;
      var contextToken = config.contextToken || '';
      var endpoint = config.endpoint || '/x/v1/support/chat';
      var title = config.title || 'Support Assistant';
      var primaryColor = config.primaryColor || '#2563eb';
      var placeholder = config.placeholder || 'Type your message...';

      if (document.getElementById('freellmapi-support-widget-root')) {
        return window.FreeLLMAPISupport._instance || null;
      }

      var root = document.createElement('div');
      root.id = 'freellmapi-support-widget-root';
      root.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:999999;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:14px;';

      var button = document.createElement('button');
      button.id = 'freellmapi-support-toggle';
      button.style.cssText = 'width:56px;height:56px;border-radius:28px;background:' + primaryColor + ';color:#fff;border:none;box-shadow:0 4px 14px rgba(0,0,0,0.25);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:transform 0.2s ease;';
      button.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

      var box = document.createElement('div');
      box.id = 'freellmapi-support-box';
      box.style.cssText = 'display:none;position:absolute;bottom:70px;right:0;width:360px;height:520px;max-width:calc(100vw - 32px);max-height:calc(100vh - 100px);background:#fff;border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,0.2);flex-direction:column;overflow:hidden;border:1px solid #e5e7eb;';

      var header = document.createElement('div');
      header.style.cssText = 'background:' + primaryColor + ';color:#fff;padding:14px 18px;display:flex;justify-content:space-between;align-items:center;font-weight:600;font-size:15px;';
      header.innerHTML = '<span>' + title + '</span><button id="freellmapi-support-close" style="background:none;border:none;color:#fff;font-size:20px;cursor:pointer;line-height:1;">&times;</button>';

      var msgList = document.createElement('div');
      msgList.id = 'freellmapi-support-messages';
      msgList.style.cssText = 'flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px;background:#f9fafb;';

      var form = document.createElement('form');
      form.style.cssText = 'display:flex;padding:12px;background:#fff;border-top:1px solid #e5e7eb;gap:8px;';
      var input = document.createElement('input');
      input.type = 'text';
      input.placeholder = placeholder;
      input.style.cssText = 'flex:1;padding:10px 14px;border:1px solid #d1d5db;border-radius:20px;outline:none;font-size:14px;';
      var sendBtn = document.createElement('button');
      sendBtn.type = 'submit';
      sendBtn.textContent = 'Send';
      sendBtn.style.cssText = 'padding:8px 16px;background:' + primaryColor + ';color:#fff;border:none;border-radius:20px;cursor:pointer;font-weight:500;';
      form.appendChild(input);
      form.appendChild(sendBtn);

      box.appendChild(header);
      box.appendChild(msgList);
      box.appendChild(form);
      root.appendChild(box);
      root.appendChild(button);
      document.body.appendChild(root);

      var history = [];
      function addMessage(role, text) {
        history.push({ role: role, content: text });
        var el = document.createElement('div');
        el.style.cssText = role === 'user'
          ? 'align-self:flex-end;max-width:80%;padding:10px 14px;background:' + primaryColor + ';color:#fff;border-radius:16px 16px 2px 16px;word-break:break-word;'
          : 'align-self:flex-start;max-width:80%;padding:10px 14px;background:#e5e7eb;color:#1f2937;border-radius:16px 16px 16px 2px;word-break:break-word;';
        el.textContent = text;
        msgList.appendChild(el);
        msgList.scrollTop = msgList.scrollHeight;
      }

      button.addEventListener('click', function() {
        var isOpen = box.style.display === 'flex';
        box.style.display = isOpen ? 'none' : 'flex';
        if (!isOpen && history.length === 0) {
          addMessage('assistant', 'Hello! How can I assist you today?');
        }
      });
      header.querySelector('#freellmapi-support-close').addEventListener('click', function() {
        box.style.display = 'none';
      });

      form.addEventListener('submit', function(e) {
        e.preventDefault();
        var text = input.value.trim();
        if (!text) return;
        input.value = '';
        addMessage('user', text);
        sendBtn.disabled = true;

        var headers = { 'Content-Type': 'application/json' };
        if (contextToken) headers['X-Support-Context-Token'] = contextToken;

        fetch(endpoint, {
          method: 'POST',
          headers: headers,
          body: JSON.stringify({
            tenantKey: tenantKey,
            contextToken: contextToken || undefined,
            messages: history
          })
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          sendBtn.disabled = false;
          var reply = data.reply || (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || 'Sorry, I could not process your request.';
          addMessage('assistant', reply);
        })
        .catch(function() {
          sendBtn.disabled = false;
          addMessage('assistant', 'Network error. Please try again later.');
        });
      });

      var instance = {
        open: function() { box.style.display = 'flex'; },
        close: function() { box.style.display = 'none'; },
        setToken: function(tok) { contextToken = tok; },
        sendMessage: function(msg) {
          input.value = msg;
          form.dispatchEvent(new Event('submit'));
        }
      };
      window.FreeLLMAPISupport._instance = instance;
      return instance;
    }
  };
})(typeof window !== 'undefined' ? window : this, typeof document !== 'undefined' ? document : {});
`;

  res.send(script);
});

// Error handling middleware for Public Router
xSupportPublicRouter.use(
  (err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    if (err instanceof SupportStoreError || err instanceof SupportConnectorError) {
      res.status(err.status).json({ error: { message: err.message, status: err.status } });
      return;
    }
    const message = err instanceof Error ? err.message : 'Support gateway error.';
    res.status(500).json({ error: { message, status: 500 } });
  },
);
