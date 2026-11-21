import { apiFetch, clearToken, getToken, UNAUTHORIZED_EVENT, type ApiError } from '@/lib/api';
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
  SupportSetupTraceStep,
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

/** One parsed Server-Sent Event block, or null for a comment/heartbeat. */
function parseSseBlock(block: string): { event: string; data: unknown } | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (data.length === 0) return null;
  try {
    return { event, data: JSON.parse(data.join('\n')) };
  } catch {
    return null;
  }
}

function apiErrorFrom(status: number, body: unknown, fallback: string): ApiError {
  const e = (body as { error?: unknown } | null)?.error;
  const message = typeof e === 'string' ? e : (e as { message?: string } | undefined)?.message;
  const err = new Error(message || fallback) as ApiError;
  err.status = status;
  err.code = typeof e === 'object' && e !== null ? (e as { type?: string }).type : undefined;
  return err;
}

/**
 * Sends a chat turn and reports the Copilot's working steps live (Server-Sent Events), resolving
 * with the same response `postSupportSetupChat` returns. If the server answers with plain JSON
 * (older server, proxy that does not stream) it behaves exactly like the non-streaming call.
 */
export async function postSupportSetupChatStream(
  body: SupportSetupChatRequest,
  onStep: (step: SupportSetupTraceStep) => void,
): Promise<SupportSetupChatResponse> {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  const token = getToken();
  const res = await fetch(`${base}/api/support-setup-copilot/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream, application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const isStream = (res.headers.get('content-type') ?? '').includes('text/event-stream');
  if (!isStream) {
    const json = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) {
      const err = apiErrorFrom(res.status, json, res.statusText || `HTTP ${res.status}`);
      if (res.status === 401 && err.code === 'authentication_error') {
        clearToken();
        window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
      }
      throw err;
    }
    return json as SupportSetupChatResponse;
  }
  if (!res.body) throw new Error('The server closed the connection before answering.');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const handle = (block: string): SupportSetupChatResponse | undefined => {
    const parsed = parseSseBlock(block);
    if (!parsed) return undefined;
    if (parsed.event === 'step') {
      onStep(parsed.data as SupportSetupTraceStep);
      return undefined;
    }
    if (parsed.event === 'final') {
      const { status, body: finalBody } = parsed.data as { status: number; body: unknown };
      if (status >= 200 && status < 300) return finalBody as SupportSetupChatResponse;
      throw apiErrorFrom(status, finalBody, `HTTP ${status}`);
    }
    return undefined;
  };
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n');
    let cut = buffer.indexOf('\n\n');
    while (cut !== -1) {
      const out = handle(buffer.slice(0, cut));
      if (out) return out;
      buffer = buffer.slice(cut + 2);
      cut = buffer.indexOf('\n\n');
    }
    if (done) break;
  }
  const tail = buffer.trim() ? handle(buffer) : undefined;
  if (tail) return tail;
  throw new Error('The connection closed before the Copilot finished answering.');
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
