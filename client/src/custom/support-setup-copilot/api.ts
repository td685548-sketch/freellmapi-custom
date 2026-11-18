import { apiFetch } from '@/lib/api';
import type {
  SupportSetupApplyRequest,
  SupportSetupApplyResponse,
  SupportSetupChatRequest,
  SupportSetupChatResponse,
  SupportSetupProposal,
  SupportSetupStatusResponse,
} from '../../../../shared/support-setup-copilot';

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
    pathname === '/assistants' ||
    pathname.startsWith('/assistants/')
  );
}

export function fetchSupportSetupStatus(tenantId?: number | null): Promise<SupportSetupStatusResponse> {
  const query = tenantId && tenantId > 0 ? `?tenantId=${tenantId}` : tenantId === null ? '?tenantId=new' : '';
  return apiFetch<SupportSetupStatusResponse>(`/api/support-setup-copilot/status${query}`);
}

export function postSupportSetupChat(body: SupportSetupChatRequest): Promise<SupportSetupChatResponse> {
  return apiFetch<SupportSetupChatResponse>('/api/support-setup-copilot/chat', {
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
