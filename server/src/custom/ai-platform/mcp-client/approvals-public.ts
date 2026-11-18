import { Router, type Request, type Response } from 'express';
import { resolveAuth } from '../../../lib/system-prompt.js';
import { extractInferenceToken } from '../../../middleware/user-rate-limit.js';
import { endUserOf } from '../../end-user-gate.js';
import { expireApprovals } from '../orchestrator/approvals.js';
import { isPillarEnabled } from '../flags.js';
import { getPublicMcpApprovalForProfile } from './chat-continuation.js';

export const mcpApprovalsPublicRouter = Router();

mcpApprovalsPublicRouter.get('/mcp-approvals/:id', (req: Request, res: Response) => {
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
        message: 'MCP approvals can only be polled with a client profile key (sk-cp-...).',
        type: 'invalid_request_error',
        code: 'mcp_approval_requires_client_key',
      },
    });
    return;
  }

  if (!isPillarEnabled('mcpClient')) {
    res.status(404).json({
      error: {
        type: 'not_found_error',
        code: 'approval_not_found',
        message: 'Approval not found.',
      },
    });
    return;
  }

  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (!rawId || !/^\d+$/.test(rawId.trim())) {
    res.status(404).json({
      error: {
        type: 'not_found_error',
        code: 'approval_not_found',
        message: 'Approval not found.',
      },
    });
    return;
  }
  const approvalId = Number(rawId.trim());
  if (!Number.isSafeInteger(approvalId) || approvalId <= 0) {
    res.status(404).json({
      error: {
        type: 'not_found_error',
        code: 'approval_not_found',
        message: 'Approval not found.',
      },
    });
    return;
  }

  try {
    expireApprovals();
  } catch {
    // Best-effort expiry sync before reading status.
  }

  const payload = getPublicMcpApprovalForProfile(approvalId, auth.profileId, endUserOf(req));
  if (!payload) {
    res.status(404).json({
      error: {
        type: 'not_found_error',
        code: 'approval_not_found',
        message: 'Approval not found.',
      },
    });
    return;
  }

  res.json(payload);
});
