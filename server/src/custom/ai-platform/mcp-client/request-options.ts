import type { Wire } from '@freellmapi/shared/ai-platform.js';

const SUPPORTED_FIELDS: Record<Wire, readonly string[]> = {
  'openai-chat': [
    'model', 'messages', 'stream', 'tools', 'tool_choice', 'user', 'n',
    'max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'stop',
    'response_format', 'frequency_penalty', 'presence_penalty',
  ],
  anthropic: [
    'model', 'messages', 'system', 'stream', 'tools', 'tool_choice',
    'max_tokens', 'temperature', 'top_p', 'stop_sequences',
  ],
  responses: [
    'model', 'input', 'instructions', 'stream', 'tools', 'tool_choice', 'user',
    'max_output_tokens', 'temperature', 'top_p', 'text',
  ],
  gemini: ['model', 'contents', 'systemInstruction', 'tools', 'toolConfig', 'generationConfig'],
};

export function hasUnsupportedFields(value: Record<string, unknown>, supported: readonly string[]): boolean {
  return Object.keys(value).some((key) => value[key] !== undefined && !supported.includes(key));
}

/** Unknown controls retain their normal gateway behavior instead of being silently discarded. */
export function hasUnsupportedRequestOptions(wire: Wire, body: Record<string, unknown>): boolean {
  if (hasUnsupportedFields(body, SUPPORTED_FIELDS[wire])) return true;
  if (wire === 'gemini' && body.generationConfig != null) {
    if (typeof body.generationConfig !== 'object' || Array.isArray(body.generationConfig)) return true;
    return hasUnsupportedFields(body.generationConfig as Record<string, unknown>, [
      'maxOutputTokens', 'temperature', 'topP', 'stopSequences', 'responseMimeType',
    ]);
  }
  return false;
}
