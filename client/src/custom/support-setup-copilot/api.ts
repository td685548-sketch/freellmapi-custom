import { apiFetch } from '@/lib/api';
import type {
  CopilotDiagnosticsResponse,
  CopilotExecuteActionRequest,
  CopilotExecuteActionResponse,
  CopilotWhoAmIResponse,
  SupportSetupApplyRequest,
  SupportSetupApplyResponse,
  SupportSetupChatRequest,
  SupportSetupChatResponse,
  SupportSetupProposal,
  SupportSetupStatusResponse,
} from '../../../../shared/support-setup-copilot';

export function isMemberPersonalCopilotRoute(pathname: string): boolean {
  return (
    pathname === '/assistants' ||
    pathname.startsWith('/assistants/') ||
    pathname === '/agents' ||
    pathname.startsWith('/agents/') ||
    pathname === '/keys' ||
    pathname.startsWith('/keys/')
  );
}

export function isSupportSetupCopilotRoute(pathname: string): boolean {
  if (pathname === '/thruline/playground' || pathname.startsWith('/thruline/playground/')) {
    return false;
  }
  if (pathname === '/thruline/accounts/callback' || pathname.startsWith('/thruline/accounts/callback/')) {
    return false;
  }
  return (
    pathname === '/thruline' ||
    pathname.startsWith('/thruline/') ||
    pathname === '/tenant-portal' ||
    pathname.startsWith('/tenant-portal/') ||
    pathname === '/settings' ||
    pathname.startsWith('/settings/') ||
    isMemberPersonalCopilotRoute(pathname)
  );
}

export function fetchSupportSetupStatus(tenantId?: number | null): Promise<SupportSetupStatusResponse> {
  const query = tenantId && tenantId > 0 ? `?tenantId=${tenantId}` : tenantId === null ? '?tenantId=new' : '';
  return apiFetch<SupportSetupStatusResponse>(`/api/support-setup-copilot/status${query}`);
}

export function fetchCopilotWhoAmI(): Promise<CopilotWhoAmIResponse> {
  return apiFetch<CopilotWhoAmIResponse>('/api/support-setup-copilot/whoami');
}

export function fetchCopilotUserDiagnostics(windowHours = 72): Promise<CopilotDiagnosticsResponse> {
  return apiFetch<CopilotDiagnosticsResponse>(
    `/api/support-setup-copilot/diagnostics?windowHours=${encodeURIComponent(String(windowHours))}`,
  );
}

export function postSupportSetupChat(body: SupportSetupChatRequest): Promise<SupportSetupChatResponse> {
  return apiFetch<SupportSetupChatResponse>('/api/support-setup-copilot/chat', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function postCopilotExecuteAction(
  body: CopilotExecuteActionRequest,
): Promise<CopilotExecuteActionResponse> {
  return apiFetch<CopilotExecuteActionResponse>('/api/support-setup-copilot/execute-action', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function postSupportSetupApply(
  proposalId: string,
  body: SupportSetupApplyRequest,
): Promise<SupportSetupApplyResponse> {
  return apiFetch<SupportSetupApplyResponse>(
    `/api/support-setup-copilot/proposals/${encodeURIComponent(proposalId)}/apply`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
  );
}

export function postSupportSetupDecline(
  proposalId: string,
): Promise<{ ok: true; proposal: SupportSetupProposal }> {
  return apiFetch<{ ok: true; proposal: SupportSetupProposal }>(
    `/api/support-setup-copilot/proposals/${encodeURIComponent(proposalId)}/decline`,
    {
      method: 'POST',
      body: JSON.stringify({}),
    },
  );
}
