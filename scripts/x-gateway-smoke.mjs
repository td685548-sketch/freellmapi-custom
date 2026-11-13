// Public ingress check; credentials come only from the invoking machine's environment.
const origin = process.env.GATEWAY_URL;
const key = process.env.X_GATEWAY_API_KEY;
const model = process.env.X_GATEWAY_MODEL;
const tool = process.env.X_GATEWAY_TOOL || 'cursor';
const timeout = () => AbortSignal.timeout(30_000);
try {
  const url = new URL(origin);
  if (url.pathname !== '/' || url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol)
    || (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('url');
  if (!key || !model || !['cursor', 'claude', 'codex', 'gemini'].includes(tool)) throw new Error('input');
  for (const endpoint of ['/livez', '/api/ping']) {
    const response = await fetch(new URL(endpoint, url), { redirect: 'error', signal: timeout() });
    await response.body?.cancel();
    console.log(`${endpoint}: ${response.status}`);
    if (!response.ok) throw new Error('health');
  }
  const endpoint = tool === 'claude' ? '/thruline/v1/messages' : tool === 'codex' ? '/thruline/v1/responses'
    : tool === 'gemini' ? `/thruline/v1beta/models/${encodeURIComponent(model)}:generateContent` : '/thruline/v1/chat/completions';
  const headers = { 'Content-Type': 'application/json', ...(tool === 'gemini' ? { 'x-goog-api-key': key } : { Authorization: `Bearer ${key}` }) };
  if (tool === 'claude') headers['anthropic-version'] = '2023-06-01';
  const body = tool === 'gemini' ? { contents: [{ role: 'user', parts: [{ text: 'Reply OK.' }] }], generationConfig: { maxOutputTokens: 16 } }
    : tool === 'codex' ? { model, input: 'Reply OK.', stream: false, max_output_tokens: 16 }
      : { model, messages: [{ role: 'user', content: 'Reply OK.' }], stream: false, max_tokens: 16 };
  const response = await fetch(new URL(endpoint, url), { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: timeout() });
  console.log(`${endpoint}: ${response.status}`);
  if (!response.ok) { await response.body?.cancel(); throw new Error('inference'); }
  const data = await response.json();
  const text = tool === 'claude' ? data.content?.map(item => item.text || '').join('')
    : tool === 'codex' ? data.output?.flatMap(item => item.content || []).map(item => item.text || '').join('')
      : tool === 'gemini' ? data.candidates?.flatMap(item => item.content?.parts || []).map(item => item.text || '').join('')
        : data.choices?.map(item => item.message?.content || '').join('');
  if (data.error || !text?.trim() || (tool === 'codex' && data.status !== 'completed')) throw new Error('output');
  console.log('PASS: selected protocol returned completed text. Streaming/tools/media remain separate checks.');
} catch {
  console.error('FAIL: check GATEWAY_URL, X_GATEWAY_API_KEY, X_GATEWAY_MODEL, protocol, health and provider configuration. No credentials or response content printed.');
  process.exitCode = 1;
}
