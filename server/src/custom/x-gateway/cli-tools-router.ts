import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getUsableXGatewayKeys } from '../provider-accounts/store.js';
import { resolveCandidateRoutes } from './router.js';
import { getConfigSnapshot } from './config.js';

export const xCliToolsRouter = Router();

const testToolSchema = z.object({
  toolId: z.string().trim().min(1).max(50),
  key: z.string().trim().max(200).optional(),
}).strict();

xCliToolsRouter.get('/', (_req: Request, res: Response) => {
  const usable = getUsableXGatewayKeys();
  const snapshot = getConfigSnapshot();
  res.json({
    enabled: snapshot.enabled,
    usableAccounts: usable.length,
    tools: [
      { id: 'claude', name: 'Claude Code', protocol: 'anthropic-messages' },
      { id: 'codex', name: 'OpenAI Codex CLI', protocol: 'openai-responses' },
      { id: 'cursor', name: 'Cursor IDE', protocol: 'openai-chat' },
      { id: 'copilot', name: 'GitHub Copilot', protocol: 'openai-chat' },
      { id: 'cline', name: 'Cline & Roo Code', protocol: 'openai-or-anthropic' },
      { id: 'openclaw', name: 'OpenClaw', protocol: 'openai-chat' },
      { id: 'continue', name: 'Continue.dev', protocol: 'openai-chat' },
      { id: 'opencode', name: 'OpenCode', protocol: 'openai-chat' },
      { id: 'antigravity', name: 'Google Antigravity', protocol: 'openai-chat' },
      { id: 'zed', name: 'Zed Editor', protocol: 'openai-chat' },
      { id: 'hermes', name: 'Hermes Agent', protocol: 'openai-chat' },
      { id: 'kiro', name: 'Kiro IDE', protocol: 'anthropic-messages' },
      { id: 'cowork', name: 'Claude Cowork', protocol: 'anthropic-messages' },
      { id: 'droid', name: 'Factory Droid', protocol: 'openai-chat' },
      { id: 'kilo', name: 'Kilo Code', protocol: 'openai-chat' },
      { id: 'roo', name: 'Roo Code', protocol: 'openai-chat' },
      { id: 'amp', name: 'Amp CLI', protocol: 'openai-chat' },
      { id: 'qwen', name: 'Qwen Code', protocol: 'openai-chat' },
      { id: 'deepseek-tui', name: 'DeepSeek TUI', protocol: 'openai-chat' },
      { id: 'jcode', name: 'jcode', protocol: 'openai-chat' },
      { id: 'grok-build', name: 'Grok Build', protocol: 'openai-chat' },
      { id: 'devin', name: 'Devin CLI', protocol: 'openai-chat' },
      { id: 'opendesign', name: 'OpenDesign', protocol: 'openai-chat' },
      { id: 'pi', name: 'Pi (pi-coding-agent)', protocol: 'openai-chat' },
      { id: 'omp', name: 'Oh My Pi', protocol: 'openai-chat' },
      { id: 'crush', name: 'Crush', protocol: 'openai-chat' },
      { id: 'forge', name: 'ForgeCode', protocol: 'openai-chat' },
      { id: 'smelt', name: 'Smelt', protocol: 'openai-chat' },
      { id: 'codewhale', name: 'CodeWhale', protocol: 'openai-chat' },
    ],
  });
});

xCliToolsRouter.post('/test', (req: Request, res: Response) => {
  const parsed = testToolSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: 'Invalid tool test request.' });
    return;
  }

  const { toolId } = parsed.data;
  const start = Date.now();

  const usable = getUsableXGatewayKeys();
  const resolution = resolveCandidateRoutes('auto');
  const latencyMs = Math.max(1, Date.now() - start);

  if (usable.length === 0) {
    res.json({
      ok: false,
      toolId,
      latencyMs,
      error: 'No active provider accounts connected in Thruline. Please connect at least one provider in Providers page.',
    });
    return;
  }

  const availableModelsCount = resolution.candidates.length;

  res.json({
    ok: true,
    toolId,
    latencyMs,
    usableAccountsCount: usable.length,
    availableModelsCount,
    message: `Thruline is ready for ${toolId} (${usable.length} active account${usable.length === 1 ? '' : 's'}).`,
  });
});
