import type { ToolProbeInput, ToolProbeResult, ToolProtocol } from '@freellmapi/shared/x-operations.js';

export const TOOL_PROTOCOLS: Record<string, ToolProtocol> = {
  claude: 'anthropic-messages', codex: 'openai-responses', gemini: 'gemini',
  cursor: 'openai-chat', copilot: 'openai-chat', cline: 'anthropic-messages',
  openclaw: 'openai-chat', continue: 'openai-chat', opencode: 'openai-chat',
  antigravity: 'openai-chat', zed: 'openai-chat',
};
export const PROBE_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

export function toolProbeRequest(input: ToolProbeInput) {
  const protocol = TOOL_PROTOCOLS[input.toolId];
  const prompt = 'Reply with OK.';
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-FreeLLM-Saver': 'off' };
  let endpoint: string;
  let body: Record<string, unknown>;
  if (protocol === 'gemini') {
    endpoint = `/x/v1beta/models/${encodeURIComponent(input.model)}:generateContent`;
    headers['x-goog-api-key'] = input.key;
    body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 16 } };
  } else {
    headers.Authorization = `Bearer ${input.key}`;
    if (protocol === 'anthropic-messages') {
      endpoint = '/x/v1/messages';
      headers['anthropic-version'] = '2023-06-01';
      body = { model: input.model, max_tokens: 16, stream: false, messages: [{ role: 'user', content: prompt }] };
    } else if (protocol === 'openai-responses') {
      endpoint = '/x/v1/responses';
      body = { model: input.model, max_output_tokens: 16, stream: false, input: prompt };
    } else {
      endpoint = '/x/v1/chat/completions';
      body = { model: input.model, max_tokens: 16, stream: false, messages: [{ role: 'user', content: prompt }] };
    }
  }
  return { protocol, endpoint, headers, body };
}

function validOutput(protocol: ToolProtocol, data: Record<string, any>): boolean {
  if (data.error) return false;
  if (protocol === 'anthropic-messages') return data.type === 'message'
    && data.content?.some((item: any) => item.type === 'text' && typeof item.text === 'string' && item.text.trim());
  if (protocol === 'openai-responses') return data.object === 'response'
    && data.status === 'completed' && data.output?.some((item: any) => item.type === 'message'
      && item.content?.some((part: any) => part.type === 'output_text' && typeof part.text === 'string' && part.text.trim()));
  if (protocol === 'gemini') return data.candidates?.some((item: any) =>
    item.content?.parts?.some((part: any) => typeof part.text === 'string' && part.text.trim()));
  return data.choices?.some((item: any) => typeof item.message?.content === 'string' && item.message.content.trim());
}

async function readJson(response: globalThis.Response): Promise<Record<string, any>> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('empty');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw new Error('oversized');
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Only the bound socket port is accepted: Host/Forwarded/custom URLs are never destinations. */
export async function probeTool(port: number, input: ToolProbeInput, signal?: AbortSignal, timeoutMs = PROBE_TIMEOUT_MS): Promise<ToolProbeResult> {
  const started = Date.now();
  const request = toolProbeRequest(input);
  const result: ToolProbeResult = {
    ok: false, toolId: input.toolId, protocol: request.protocol, model: input.model,
    endpoint: request.endpoint, latencyMs: 0, checkedAt: new Date().toISOString(),
  };
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port');
    const response = await fetch(`http://127.0.0.1:${port}${request.endpoint}`, {
      method: 'POST', headers: request.headers, body: JSON.stringify(request.body),
      redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    result.status = response.status;
    if (!response.ok) {
      await response.body?.cancel();
      result.error = response.status === 401 ? 'API key is invalid or revoked.'
        : response.status === 403 ? 'API key lacks permission or access to the selected model.'
        : response.status === 404 ? 'Gateway is disabled, or the selected model/endpoint is unavailable.'
        : response.status === 429 ? 'Request rate limit reached. Retry later.'
        : 'Inference failed. Check provider availability and gateway logs.';
    } else {
      result.ok = Boolean(validOutput(request.protocol, await readJson(response)));
      if (result.ok) result.message = 'Inference completed through the selected protocol and model.';
      else result.error = 'Inference returned no valid completed text response.';
    }
  } catch {
    result.error = timeout.aborted ? 'Inference test timed out.'
      : signal?.aborted ? 'Inference test cancelled.' : 'Inference test could not read a valid response.';
  }
  result.latencyMs = Date.now() - started;
  return result;
}
