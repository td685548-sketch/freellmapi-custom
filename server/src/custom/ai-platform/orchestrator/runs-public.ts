import { Router, type Request, type Response } from 'express';
import type { PublicFlowRunResponse } from '@freellmapi/shared/ai-platform-orchestrator.js';
import { resolveAuth } from '../../../lib/system-prompt.js';
import { extractInferenceToken } from '../../../middleware/user-rate-limit.js';
import { isPillarEnabled } from '../flags.js';
import { expireApprovals } from './approvals.js';
import { getRunRecord } from './trace.js';

export const runsPublicRouter = Router();

runsPublicRouter.get('/runs/:id', (req: Request, res: Response) => {
  const token = extractInferenceToken(req);
  const auth = resolveAuth(token);
  if (!auth) {
    res.status(401).json({
      error: {
        message: 'Invalid API key',
        type: 'authentication_error',
      },
    });
    return;
  }

  if (auth.kind !== 'profile') {
    res.status(400).json({
      error: {
        message: 'Flow runs can only be inspected with a client profile key (sk-cp-...).',
        type: 'invalid_request_error',
        code: 'flow_requires_client_key',
      },
    });
    return;
  }

  if (!isPillarEnabled('orchestrator')) {
    res.status(404).json({
      error: {
        type: 'not_found_error',
        code: 'run_not_found',
        message: 'Run not found.',
      },
    });
    return;
  }

  const runIdRaw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const runId = typeof runIdRaw === 'string' ? runIdRaw.trim() : '';
  if (!runId) {
    res.status(404).json({
      error: {
        type: 'not_found_error',
        code: 'run_not_found',
        message: 'Run not found.',
      },
    });
    return;
  }

  try {
    expireApprovals();
  } catch {
    // Best-effort expiry sync before reading run status
  }

  const rec = getRunRecord(runId);
  if (!rec || rec.run.profileId !== auth.profileId || rec.run.isDryRun) {
    res.status(404).json({
      error: {
        type: 'not_found_error',
        code: 'run_not_found',
        message: 'Run not found.',
      },
    });
    return;
  }

  const { run } = rec;
  const terminalOutput =
    run.status === 'running' || run.status === 'awaiting_approval'
      ? null
      : run.finalTextMasked;

  const payload: PublicFlowRunResponse = {
    id: run.id,
    flow: run.flowSlug,
    status: run.status,
    stop_reason: run.stopReason,
    output_text: terminalOutput,
    usage: {
      prompt_tokens: run.promptTokens,
      completion_tokens: run.completionTokens,
      total_tokens: run.promptTokens + run.completionTokens,
    },
    started_at: run.startedAt,
    finished_at: run.finishedAt,
  };

  res.json(payload);
});
