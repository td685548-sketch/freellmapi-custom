import crypto from 'node:crypto';
import type {
  ChatContentBlock,
  ChatMessage,
  ChatToolCall,
  ChatToolChoice,
  ChatToolDefinition,
} from '@freellmapi/shared/types.js';
import { contentToString, estimateInputTokens } from '../../lib/content.js';

export type ProtocolType =
  | 'openai_chat'
  | 'anthropic'
  | 'openai_responses'
  | 'gemini'
  | 'sse_openai'
  | 'sse_anthropic';

export type PipelineStepStatus = 'ok' | 'warn' | 'info' | 'error';

export interface PipelineStep {
  step: number;
  name: string;
  status: PipelineStepStatus;
  title: string;
  details: string;
  metadata?: Record<string, unknown>;
}

export interface TranslationStats {
  sourceTokens: number;
  targetTokens: number;
  delta: number;
  warnings: string[];
  lossyFields: string[];
}

export interface TranslationResult {
  success: boolean;
  sourceProtocol: ProtocolType;
  targetProtocol: ProtocolType;
  transformed: Record<string, unknown>;
  steps: PipelineStep[];
  stats: TranslationStats;
}

export interface NormalizedRequest {
  systemPrompt?: string;
  messages: ChatMessage[];
  tools?: ChatToolDefinition[];
  toolChoice?: ChatToolChoice;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  topK?: number;
  stopSequences?: string[];
  stream?: boolean;
  thinking?: {
    type?: string;
    budgetTokens?: number;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeJson(val: unknown): string {
  try {
    return typeof val === 'string' ? val : JSON.stringify(val ?? {});
  } catch {
    return '{}';
  }
}

function parseJson(val: unknown): Record<string, unknown> {
  if (typeof val === 'object' && val !== null) return val as Record<string, unknown>;
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      if (typeof parsed === 'object' && parsed !== null) return parsed;
    } catch {
      // ignore
    }
  }
  return {};
}

function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// Ingestion: Protocol -> NormalizedRequest
// ---------------------------------------------------------------------------

export function ingestOpenAIChat(
  body: Record<string, any>,
  steps: PipelineStep[],
  _lossyFields?: string[],
  _warnings?: string[]
): NormalizedRequest {
  steps.push({
    step: 1,
    name: 'Protocol Ingestion & Validation',
    status: 'ok',
    title: 'OpenAI Chat Completions Schema Parsed',
    details: `Parsed payload with model '${body.model ?? 'unspecified'}' and ${Array.isArray(body.messages) ? body.messages.length : 0} messages.`,
  });

  // Step 2: System Message Extraction
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const systemParts: string[] = [];
  const nonSystemMessages: ChatMessage[] = [];

  for (const msg of rawMessages) {
    if (!msg || typeof msg !== 'object') continue;
    const role = msg.role === 'developer' ? 'system' : msg.role;
    if (role === 'system') {
      const txt = contentToString(msg.content);
      if (txt.trim()) systemParts.push(txt.trim());
    } else {
      nonSystemMessages.push(msg);
    }
  }

  const systemPrompt = systemParts.length > 0 ? systemParts.join('\n\n') : undefined;
  steps.push({
    step: 2,
    name: 'System Message Extraction',
    status: 'ok',
    title: 'Extracted System Instructions',
    details: systemPrompt
      ? `Extracted ${systemParts.length} system/developer block(s) into isolated system prompt (${systemPrompt.length} chars).`
      : 'No system/developer instructions present in payload.',
  });

  // Step 3: Turn & Role Normalization
  const normalizedMessages: ChatMessage[] = [];
  for (const msg of nonSystemMessages) {
    const role = msg.role;
    if (role === 'tool') {
      normalizedMessages.push({
        role: 'tool',
        tool_call_id: String(msg.tool_call_id ?? ''),
        content: contentToString(msg.content),
      });
    } else if (role === 'assistant') {
      const toolCalls: ChatToolCall[] = Array.isArray(msg.tool_calls)
        ? msg.tool_calls.map((tc: any) => ({
            id: String(tc.id ?? randomId('call')),
            type: 'function',
            function: {
              name: String(tc.function?.name ?? ''),
              arguments: safeJson(tc.function?.arguments),
            },
          }))
        : [];
      normalizedMessages.push({
        role: 'assistant',
        content: msg.content ? contentToString(msg.content) : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    } else {
      // user or multimodal
      normalizedMessages.push({
        role: 'user',
        content: msg.content,
      });
    }
  }

  steps.push({
    step: 3,
    name: 'Turn & Role Normalization',
    status: 'ok',
    title: 'Normalized Dialogue Turns',
    details: `Standardized ${normalizedMessages.length} conversation turns (user/assistant/tool).`,
  });

  // Step 4: Content & Multimodal Adaptation
  let hasMultimodal = false;
  for (const msg of normalizedMessages) {
    if (Array.isArray(msg.content)) {
      hasMultimodal = true;
      break;
    }
  }

  steps.push({
    step: 4,
    name: 'Content & Multimodal Adaptation',
    status: hasMultimodal ? 'info' : 'ok',
    title: hasMultimodal ? 'Multimodal Content Detected' : 'Text Content Standardized',
    details: hasMultimodal
      ? 'Detected image/structured content blocks in user turns; preserving format for cross-compilation.'
      : 'All message content conforms to plain UTF-8 text strings.',
  });

  // Step 5: Tools & Function Schemas
  const tools: ChatToolDefinition[] | undefined = Array.isArray(body.tools)
    ? body.tools
        .filter((t: any) => t?.type === 'function' && t.function?.name)
        .map((t: any) => ({
          type: 'function' as const,
          function: {
            name: String(t.function.name),
            ...(t.function.description ? { description: String(t.function.description) } : {}),
            parameters: parseJson(t.function.parameters),
          },
        }))
    : undefined;

  let toolChoice: ChatToolChoice | undefined;
  if (body.tool_choice) {
    if (typeof body.tool_choice === 'string') {
      if (['auto', 'none', 'required'].includes(body.tool_choice)) {
        toolChoice = body.tool_choice as ChatToolChoice;
      }
    } else if (typeof body.tool_choice === 'object') {
      if (body.tool_choice.type === 'function' && body.tool_choice.function?.name) {
        toolChoice = {
          type: 'function',
          function: { name: String(body.tool_choice.function.name) },
        };
      }
    }
  }

  steps.push({
    step: 5,
    name: 'Tool Calling & Function Schemas',
    status: tools && tools.length > 0 ? 'info' : 'ok',
    title: tools && tools.length > 0 ? `${tools.length} Tool(s) Parsed` : 'No Tools Defined',
    details: tools && tools.length > 0
      ? `Parsed function declarations: ${tools.map((t) => t.function.name).join(', ')} with tool_choice '${typeof toolChoice === 'object' ? toolChoice.function.name : toolChoice ?? 'default'}'.`
      : 'No client tools provided in payload.',
  });

  // Step 6: Hyperparameters
  const maxTokens = typeof body.max_tokens === 'number'
    ? body.max_tokens
    : typeof body.max_completion_tokens === 'number'
      ? body.max_completion_tokens
      : undefined;

  const stopSequences = Array.isArray(body.stop)
    ? body.stop.map(String)
    : typeof body.stop === 'string'
      ? [body.stop]
      : undefined;

  steps.push({
    step: 6,
    name: 'Hyperparameters & Controls',
    status: 'ok',
    title: 'Extracted Sampling Controls',
    details: `temperature: ${body.temperature ?? 'unset'}, max_tokens: ${maxTokens ?? 'unset'}, stream: ${Boolean(body.stream)}.`,
  });

  return {
    model: body.model,
    systemPrompt,
    messages: normalizedMessages,
    tools,
    toolChoice,
    temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
    maxTokens,
    topP: typeof body.top_p === 'number' ? body.top_p : undefined,
    stopSequences,
    stream: Boolean(body.stream),
  };
}

export function ingestAnthropic(
  body: Record<string, any>,
  steps: PipelineStep[],
  _lossyFields?: string[],
  _warnings?: string[]
): NormalizedRequest {
  steps.push({
    step: 1,
    name: 'Protocol Ingestion & Validation',
    status: 'ok',
    title: 'Anthropic Messages Schema Parsed',
    details: `Parsed Anthropic payload for model '${body.model ?? 'unspecified'}' with max_tokens=${body.max_tokens ?? 'unspecified'}.`,
  });

  // Step 2: System Message Extraction
  let systemPrompt: string | undefined;
  if (typeof body.system === 'string') {
    systemPrompt = body.system.trim();
  } else if (Array.isArray(body.system)) {
    systemPrompt = body.system
      .map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n\n');
  }

  steps.push({
    step: 2,
    name: 'System Message Extraction',
    status: 'ok',
    title: 'Extracted Anthropic System Prompt',
    details: systemPrompt
      ? `Isolated root 'system' parameter (${systemPrompt.length} chars).`
      : 'No root system prompt provided in Anthropic payload.',
  });

  // Step 3 & 4: Turn & Role Normalization + Multimodal
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const normalizedMessages: ChatMessage[] = [];

  for (const msg of rawMessages) {
    if (!msg || typeof msg !== 'object') continue;
    const role = msg.role;

    if (typeof msg.content === 'string') {
      normalizedMessages.push({
        role: role === 'assistant' ? 'assistant' : 'user',
        content: msg.content,
      });
      continue;
    }

    if (Array.isArray(msg.content)) {
      const textParts: string[] = [];
      const imageBlocks: ChatContentBlock[] = [];
      const toolCalls: ChatToolCall[] = [];
      const toolResults: ChatMessage[] = [];

      for (const block of msg.content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string') {
          textParts.push(block.text);
        } else if (block.type === 'image' && block.source) {
          const src = block.source;
          const url =
            src.type === 'base64' && src.media_type && src.data
              ? `data:${src.media_type};base64,${src.data}`
              : typeof src.url === 'string'
                ? src.url
                : null;
          if (url) imageBlocks.push({ type: 'image_url', image_url: { url } } as ChatContentBlock);
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: String(block.id ?? randomId('toolu')),
            type: 'function',
            function: {
              name: String(block.name ?? ''),
              arguments: safeJson(block.input),
            },
          });
        } else if (block.type === 'tool_result') {
          let resContent = '';
          if (typeof block.content === 'string') {
            resContent = block.content;
          } else if (Array.isArray(block.content)) {
            resContent = block.content
              .map((b: any) => (typeof b?.text === 'string' ? b.text : ''))
              .filter(Boolean)
              .join('\n');
          }
          toolResults.push({
            role: 'tool',
            tool_call_id: String(block.tool_use_id ?? ''),
            content: resContent,
          });
        }
      }

      const joinedText = textParts.join('\n');
      if (role === 'assistant') {
        normalizedMessages.push({
          role: 'assistant',
          content: joinedText.length > 0 ? joinedText : null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });
      } else {
        normalizedMessages.push(...toolResults);
        if (imageBlocks.length > 0) {
          const contentBlocks: ChatContentBlock[] = [];
          if (joinedText) contentBlocks.push({ type: 'text', text: joinedText });
          contentBlocks.push(...imageBlocks);
          normalizedMessages.push({ role: 'user', content: contentBlocks });
        } else if (joinedText.length > 0) {
          normalizedMessages.push({ role: 'user', content: joinedText });
        }
      }
    }
  }

  steps.push({
    step: 3,
    name: 'Turn & Role Normalization',
    status: 'ok',
    title: 'Anthropic Turns Converted',
    details: `Normalized ${normalizedMessages.length} turns into standard chat turn structure.`,
  });

  steps.push({
    step: 4,
    name: 'Content & Multimodal Adaptation',
    status: 'ok',
    title: 'Content Blocks Normalized',
    details: 'Converted Anthropic text/image/tool_use/tool_result blocks into standard envelopes.',
  });

  // Step 5: Tools & Function Schemas
  const tools: ChatToolDefinition[] | undefined = Array.isArray(body.tools)
    ? body.tools
        .filter((t: any) => t && typeof t.name === 'string')
        .map((t: any) => ({
          type: 'function' as const,
          function: {
            name: String(t.name),
            ...(t.description ? { description: String(t.description) } : {}),
            parameters: parseJson(t.input_schema),
          },
        }))
    : undefined;

  let toolChoice: ChatToolChoice | undefined;
  if (body.tool_choice && typeof body.tool_choice === 'object') {
    const tcType = body.tool_choice.type;
    if (tcType === 'auto') toolChoice = 'auto';
    else if (tcType === 'none') toolChoice = 'none';
    else if (tcType === 'any') toolChoice = 'required';
    else if (tcType === 'tool' && typeof body.tool_choice.name === 'string') {
      toolChoice = { type: 'function', function: { name: body.tool_choice.name } };
    }
  }

  steps.push({
    step: 5,
    name: 'Tool Calling & Function Schemas',
    status: tools && tools.length > 0 ? 'info' : 'ok',
    title: tools && tools.length > 0 ? `${tools.length} Anthropic Tool(s) Found` : 'No Tools',
    details: tools && tools.length > 0
      ? `Converted Anthropic 'input_schema' to JSON Schema definitions.`
      : 'No tools defined.',
  });

  // Step 6: Hyperparameters
  const thinking = body.thinking && typeof body.thinking === 'object'
    ? {
        type: String(body.thinking.type ?? 'enabled'),
        budgetTokens: typeof body.thinking.budget_tokens === 'number' ? body.thinking.budget_tokens : undefined,
      }
    : undefined;

  steps.push({
    step: 6,
    name: 'Hyperparameters & Controls',
    status: 'ok',
    title: 'Anthropic Sampling Extracted',
    details: `max_tokens: ${body.max_tokens ?? 'none'}, temperature: ${body.temperature ?? 'default'}${thinking ? `, thinking budget: ${thinking.budgetTokens}` : ''}.`,
  });

  return {
    model: body.model,
    systemPrompt,
    messages: normalizedMessages,
    tools,
    toolChoice,
    temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
    maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : undefined,
    topP: typeof body.top_p === 'number' ? body.top_p : undefined,
    topK: typeof body.top_k === 'number' ? body.top_k : undefined,
    stopSequences: Array.isArray(body.stop_sequences) ? body.stop_sequences.map(String) : undefined,
    stream: Boolean(body.stream),
    thinking,
  };
}

export function ingestGemini(
  body: Record<string, any>,
  steps: PipelineStep[],
  _lossyFields?: string[],
  _warnings?: string[]
): NormalizedRequest {
  steps.push({
    step: 1,
    name: 'Protocol Ingestion & Validation',
    status: 'ok',
    title: 'Google Gemini Schema Parsed',
    details: `Parsed Gemini contents with ${Array.isArray(body.contents) ? body.contents.length : 0} items.`,
  });

  // Step 2: System Message
  let systemPrompt: string | undefined;
  if (body.systemInstruction?.parts && Array.isArray(body.systemInstruction.parts)) {
    systemPrompt = body.systemInstruction.parts
      .map((p: any) => (typeof p?.text === 'string' ? p.text : ''))
      .filter(Boolean)
      .join('\n\n');
  }

  steps.push({
    step: 2,
    name: 'System Message Extraction',
    status: 'ok',
    title: 'Extracted systemInstruction',
    details: systemPrompt
      ? `Isolated Gemini 'systemInstruction' (${systemPrompt.length} chars).`
      : 'No systemInstruction present.',
  });

  // Step 3 & 4: Turn & Role Normalization
  const rawContents = Array.isArray(body.contents) ? body.contents : [];
  const normalizedMessages: ChatMessage[] = [];

  for (const item of rawContents) {
    if (!item || typeof item !== 'object') continue;
    const role = item.role === 'model' ? 'assistant' : 'user';
    const parts = Array.isArray(item.parts) ? item.parts : [];

    const textParts: string[] = [];
    const imageBlocks: ChatContentBlock[] = [];
    const toolCalls: ChatToolCall[] = [];
    const toolResults: ChatMessage[] = [];

    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      if (typeof part.text === 'string') {
        textParts.push(part.text);
      } else if (part.inlineData) {
        const mime = part.inlineData.mimeType || 'image/png';
        const data = part.inlineData.data || '';
        imageBlocks.push({
          type: 'image_url',
          image_url: { url: `data:${mime};base64,${data}` },
        } as ChatContentBlock);
      } else if (part.functionCall) {
        toolCalls.push({
          id: randomId('call'),
          type: 'function',
          function: {
            name: String(part.functionCall.name ?? ''),
            arguments: safeJson(part.functionCall.args),
          },
        });
      } else if (part.functionResponse) {
        toolResults.push({
          role: 'tool',
          tool_call_id: randomId('call_res'),
          content: safeJson(part.functionResponse.response),
        });
      }
    }

    const joinedText = textParts.join('\n');
    if (role === 'assistant') {
      normalizedMessages.push({
        role: 'assistant',
        content: joinedText.length > 0 ? joinedText : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    } else {
      normalizedMessages.push(...toolResults);
      if (imageBlocks.length > 0) {
        const blocks: ChatContentBlock[] = [];
        if (joinedText) blocks.push({ type: 'text', text: joinedText });
        blocks.push(...imageBlocks);
        normalizedMessages.push({ role: 'user', content: blocks });
      } else if (joinedText.length > 0) {
        normalizedMessages.push({ role: 'user', content: joinedText });
      }
    }
  }

  steps.push({
    step: 3,
    name: 'Turn & Role Normalization',
    status: 'ok',
    title: 'Gemini Role Mapping',
    details: `Mapped Gemini 'model' -> 'assistant' and 'user' -> 'user' (${normalizedMessages.length} turns).`,
  });

  steps.push({
    step: 4,
    name: 'Content & Multimodal Adaptation',
    status: 'ok',
    title: 'Gemini Parts Converted',
    details: 'Converted text, inlineData, functionCall, and functionResponse into standard message envelopes.',
  });

  // Step 5: Tools
  let tools: ChatToolDefinition[] | undefined;
  if (Array.isArray(body.tools)) {
    const defs: ChatToolDefinition[] = [];
    for (const toolGroup of body.tools) {
      if (toolGroup?.functionDeclarations && Array.isArray(toolGroup.functionDeclarations)) {
        for (const fn of toolGroup.functionDeclarations) {
          if (fn && typeof fn.name === 'string') {
            defs.push({
              type: 'function',
              function: {
                name: fn.name,
                ...(fn.description ? { description: fn.description } : {}),
                parameters: parseJson(fn.parameters),
              },
            });
          }
        }
      }
    }
    if (defs.length > 0) tools = defs;
  }

  steps.push({
    step: 5,
    name: 'Tool Calling & Function Schemas',
    status: tools && tools.length > 0 ? 'info' : 'ok',
    title: tools && tools.length > 0 ? `${tools.length} Gemini Tool(s)` : 'No Tools',
    details: tools && tools.length > 0
      ? `Extracted functionDeclarations into standard ChatToolDefinition.`
      : 'No functionDeclarations found.',
  });

  // Step 6: GenerationConfig
  const cfg = body.generationConfig || {};
  steps.push({
    step: 6,
    name: 'Hyperparameters & Controls',
    status: 'ok',
    title: 'Extracted generationConfig',
    details: `temperature: ${cfg.temperature ?? 'default'}, maxOutputTokens: ${cfg.maxOutputTokens ?? 'default'}.`,
  });

  return {
    systemPrompt,
    messages: normalizedMessages,
    tools,
    temperature: typeof cfg.temperature === 'number' ? cfg.temperature : undefined,
    maxTokens: typeof cfg.maxOutputTokens === 'number' ? cfg.maxOutputTokens : undefined,
    topP: typeof cfg.topP === 'number' ? cfg.topP : undefined,
    topK: typeof cfg.topK === 'number' ? cfg.topK : undefined,
    stopSequences: Array.isArray(cfg.stopSequences) ? cfg.stopSequences.map(String) : undefined,
  };
}

export function ingestOpenAIResponses(
  body: Record<string, any>,
  steps: PipelineStep[],
  _lossyFields?: string[],
  _warnings?: string[]
): NormalizedRequest {
  steps.push({
    step: 1,
    name: 'Protocol Ingestion & Validation',
    status: 'ok',
    title: 'OpenAI Responses API Ingested',
    details: `Parsed /v1/responses format for model '${body.model ?? 'unspecified'}'.`,
  });

  // Step 2: System / Instructions
  const systemPrompt = typeof body.instructions === 'string' && body.instructions.trim()
    ? body.instructions.trim()
    : undefined;

  steps.push({
    step: 2,
    name: 'System Message Extraction',
    status: 'ok',
    title: 'Extracted instructions Parameter',
    details: systemPrompt
      ? `Mapped top-level 'instructions' into system prompt (${systemPrompt.length} chars).`
      : 'No top-level instructions parameter found.',
  });

  // Step 3 & 4: Turn / Input Items
  const messages: ChatMessage[] = [];
  if (typeof body.input === 'string') {
    messages.push({ role: 'user', content: body.input });
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'function_call') {
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: String(item.call_id ?? item.id ?? randomId('call')),
              type: 'function',
              function: {
                name: String(item.name ?? ''),
                arguments: typeof item.arguments === 'string' ? item.arguments : safeJson(item.arguments),
              },
            },
          ],
        });
        continue;
      }
      if (item.type === 'function_call_output') {
        messages.push({
          role: 'tool',
          tool_call_id: String(item.call_id ?? ''),
          content: typeof item.output === 'string' ? item.output : safeJson(item.output),
        });
        continue;
      }
      const role = item.role === 'developer' ? 'system' : item.role;
      if (role !== 'system' && role !== 'user' && role !== 'assistant') continue;
      let text = '';
      if (typeof item.content === 'string') {
        text = item.content;
      } else if (Array.isArray(item.content)) {
        text = item.content
          .map((p: any) => (typeof p?.text === 'string' ? p.text : ''))
          .filter(Boolean)
          .join('');
      }
      if (text) messages.push({ role: role as 'system' | 'user' | 'assistant', content: text });
    }
  }

  steps.push({
    step: 3,
    name: 'Turn & Role Normalization',
    status: 'ok',
    title: 'Converted Input Items',
    details: `Converted ${messages.length} input items into conversation dialogue turns.`,
  });

  steps.push({
    step: 4,
    name: 'Content & Multimodal Adaptation',
    status: 'ok',
    title: 'Responses Input Processed',
    details: 'Converted function_call and function_call_output items into standard tool structures.',
  });

  // Tools
  const tools: ChatToolDefinition[] | undefined = Array.isArray(body.tools)
    ? body.tools
        .filter((t: any) => t && (t.type === 'function' || typeof t.name === 'string'))
        .map((t: any) => ({
          type: 'function' as const,
          function: {
            name: String(t.name ?? t.function?.name ?? ''),
            ...(t.description || t.function?.description
              ? { description: String(t.description ?? t.function?.description) }
              : {}),
            parameters: parseJson(t.parameters ?? t.function?.parameters),
          },
        }))
    : undefined;

  steps.push({
    step: 5,
    name: 'Tool Calling & Function Schemas',
    status: tools && tools.length > 0 ? 'info' : 'ok',
    title: tools && tools.length > 0 ? `${tools.length} Tool(s) Parsed` : 'No Tools',
    details: tools && tools.length > 0
      ? `Parsed Responses tools: ${tools.map((t) => t.function.name).join(', ')}.`
      : 'No tools defined.',
  });

  steps.push({
    step: 6,
    name: 'Hyperparameters & Controls',
    status: 'ok',
    title: 'Responses Hyperparameters',
    details: `temperature: ${body.temperature ?? 'default'}, max_output_tokens: ${body.max_output_tokens ?? 'default'}.`,
  });

  return {
    model: body.model,
    systemPrompt,
    messages,
    tools,
    temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
    maxTokens: typeof body.max_output_tokens === 'number' ? body.max_output_tokens : undefined,
  };
}

// ---------------------------------------------------------------------------
// Compilation: NormalizedRequest -> Target Protocol
// ---------------------------------------------------------------------------

export function compileToOpenAIChat(
  norm: NormalizedRequest,
  steps: PipelineStep[],
  _lossyFields?: string[],
  _warnings?: string[]
): Record<string, unknown> {
  const resultMessages: ChatMessage[] = [];

  if (norm.systemPrompt) {
    resultMessages.push({ role: 'system', content: norm.systemPrompt });
  }

  for (const msg of norm.messages) {
    resultMessages.push(msg);
  }

  const payload: Record<string, unknown> = {
    model: norm.model ?? 'gpt-4o',
    messages: resultMessages,
  };

  if (norm.tools && norm.tools.length > 0) {
    payload.tools = norm.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.function.name,
        ...(t.function.description ? { description: t.function.description } : {}),
        parameters: t.function.parameters ?? { type: 'object', properties: {} },
      },
    }));

    if (norm.toolChoice) {
      payload.tool_choice = norm.toolChoice;
    }
  }

  if (typeof norm.temperature === 'number') payload.temperature = norm.temperature;
  if (typeof norm.maxTokens === 'number') payload.max_tokens = norm.maxTokens;
  if (typeof norm.topP === 'number') payload.top_p = norm.topP;
  if (norm.stopSequences && norm.stopSequences.length > 0) payload.stop = norm.stopSequences;
  if (norm.stream) payload.stream = true;

  if (norm.thinking) {
    payload.reasoning_effort = norm.thinking.budgetTokens && norm.thinking.budgetTokens > 2048 ? 'high' : 'medium';
    steps.push({
      step: 7,
      name: 'Target Assembly & Token Estimation',
      status: 'info',
      title: 'Reasoning Effort Mapped',
      details: `Mapped thinking budget to OpenAI reasoning_effort '${payload.reasoning_effort}'.`,
    });
  }

  return payload;
}

export function compileToAnthropic(
  norm: NormalizedRequest,
  _steps?: PipelineStep[],
  _lossyFields?: string[],
  warnings: string[] = []
): Record<string, unknown> {
  const anthropicMessages: Array<Record<string, unknown>> = [];

  for (const msg of norm.messages) {
    if (msg.role === 'system') {
      // If there's an embedded system message, add it to systemPrompt
      const txt = contentToString(msg.content);
      norm.systemPrompt = norm.systemPrompt ? `${norm.systemPrompt}\n\n${txt}` : txt;
      continue;
    }

    if (msg.role === 'tool') {
      // In Anthropic, tool execution results are sent inside a user turn as type: "tool_result"
      anthropicMessages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: msg.tool_call_id ?? randomId('toolu'),
            content: contentToString(msg.content),
          },
        ],
      });
      continue;
    }

    if (msg.role === 'assistant') {
      const contentBlocks: Array<Record<string, unknown>> = [];
      const txt = contentToString(msg.content);
      if (txt.trim()) {
        contentBlocks.push({ type: 'text', text: txt });
      }
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          contentBlocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: parseJson(tc.function.arguments),
          });
        }
      }
      anthropicMessages.push({
        role: 'assistant',
        content: contentBlocks.length === 1 && contentBlocks[0].type === 'text' ? txt : contentBlocks,
      });
      continue;
    }

    // User turn
    if (typeof msg.content === 'string') {
      anthropicMessages.push({ role: 'user', content: msg.content });
    } else if (Array.isArray(msg.content)) {
      const blocks: Array<Record<string, unknown>> = [];
      for (const b of msg.content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text' && typeof (b as any).text === 'string') {
          blocks.push({ type: 'text', text: (b as any).text });
        } else if (b.type === 'image_url' && (b as any).image_url?.url) {
          const url: string = (b as any).image_url.url;
          if (url.startsWith('data:')) {
            const match = url.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
              blocks.push({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: match[1],
                  data: match[2],
                },
              });
            }
          } else {
            blocks.push({
              type: 'image',
              source: { type: 'url', url },
            });
          }
        }
      }
      anthropicMessages.push({ role: 'user', content: blocks.length > 0 ? blocks : contentToString(msg.content) });
    } else {
      anthropicMessages.push({ role: 'user', content: contentToString(msg.content) });
    }
  }

  // Ensure alternating turns for Anthropic (user -> assistant -> user)
  const consolidatedMessages: Array<Record<string, unknown>> = [];
  for (const m of anthropicMessages) {
    const prev = consolidatedMessages[consolidatedMessages.length - 1];
    if (prev && prev.role === m.role) {
      warnings.push(`Consolidated consecutive '${m.role}' turns into single turn for Anthropic compliance.`);
      if (typeof prev.content === 'string' && typeof m.content === 'string') {
        prev.content = `${prev.content}\n\n${m.content}`;
      } else {
        const prevArray = Array.isArray(prev.content)
          ? prev.content
          : [{ type: 'text', text: String(prev.content) }];
        const currArray = Array.isArray(m.content)
          ? m.content
          : [{ type: 'text', text: String(m.content) }];
        prev.content = [...prevArray, ...currArray];
      }
    } else {
      consolidatedMessages.push(m);
    }
  }

  const payload: Record<string, unknown> = {
    model: norm.model ?? 'claude-3-7-sonnet-20250219',
    max_tokens: norm.maxTokens ?? 4096,
    messages: consolidatedMessages,
  };

  if (norm.systemPrompt) {
    payload.system = norm.systemPrompt;
  }

  if (norm.tools && norm.tools.length > 0) {
    payload.tools = norm.tools.map((t) => ({
      name: t.function.name,
      ...(t.function.description ? { description: t.function.description } : {}),
      input_schema: t.function.parameters ?? { type: 'object', properties: {} },
    }));

    if (norm.toolChoice) {
      if (typeof norm.toolChoice === 'string') {
        if (norm.toolChoice === 'auto') payload.tool_choice = { type: 'auto' };
        else if (norm.toolChoice === 'none') payload.tool_choice = { type: 'none' };
        else if (norm.toolChoice === 'required') payload.tool_choice = { type: 'any' };
      } else if (typeof norm.toolChoice === 'object' && norm.toolChoice.function?.name) {
        payload.tool_choice = { type: 'tool', name: norm.toolChoice.function.name };
      }
    }
  }

  if (typeof norm.temperature === 'number') payload.temperature = norm.temperature;
  if (norm.stopSequences && norm.stopSequences.length > 0) payload.stop_sequences = norm.stopSequences;
  if (norm.stream) payload.stream = true;

  if (norm.thinking) {
    payload.thinking = {
      type: 'enabled',
      budget_tokens: norm.thinking.budgetTokens ?? 2048,
    };
  }

  return payload;
}

export function compileToGemini(
  norm: NormalizedRequest,
  _steps?: PipelineStep[],
  _lossyFields?: string[],
  warnings: string[] = []
): Record<string, unknown> {
  const contents: Array<Record<string, unknown>> = [];

  for (const msg of norm.messages) {
    if (msg.role === 'system') {
      const txt = contentToString(msg.content);
      norm.systemPrompt = norm.systemPrompt ? `${norm.systemPrompt}\n\n${txt}` : txt;
      continue;
    }

    if (msg.role === 'tool') {
      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: msg.tool_call_id || 'tool_response',
              response: { content: contentToString(msg.content) },
            },
          },
        ],
      });
      continue;
    }

    if (msg.role === 'assistant') {
      const parts: Array<Record<string, unknown>> = [];
      const txt = contentToString(msg.content);
      if (txt.trim()) parts.push({ text: txt });

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          parts.push({
            functionCall: {
              name: tc.function.name,
              args: parseJson(tc.function.arguments),
            },
          });
        }
      }

      contents.push({ role: 'model', parts: parts.length > 0 ? parts : [{ text: '' }] });
      continue;
    }

    // User turn
    const parts: Array<Record<string, unknown>> = [];
    if (typeof msg.content === 'string') {
      parts.push({ text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text' && typeof (b as any).text === 'string') {
          parts.push({ text: (b as any).text });
        } else if (b.type === 'image_url' && (b as any).image_url?.url) {
          const url: string = (b as any).image_url.url;
          if (url.startsWith('data:')) {
            const match = url.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
              parts.push({
                inlineData: {
                  mimeType: match[1],
                  data: match[2],
                },
              });
            }
          } else {
            warnings.push('Remote image URL converted to text descriptor since Gemini requires inlineData or File API URI.');
            parts.push({ text: `[Image: ${url}]` });
          }
        }
      }
    } else {
      parts.push({ text: contentToString(msg.content) });
    }

    contents.push({ role: 'user', parts: parts.length > 0 ? parts : [{ text: '' }] });
  }

  // Consolidate consecutive turns for Gemini
  const consolidated: Array<Record<string, unknown>> = [];
  for (const c of contents) {
    const prev = consolidated[consolidated.length - 1];
    if (prev && prev.role === c.role) {
      warnings.push(`Merged consecutive '${c.role}' turns into single turn for Gemini API compliance.`);
      const prevParts = (prev.parts as Array<Record<string, unknown>>) || [];
      const currParts = (c.parts as Array<Record<string, unknown>>) || [];
      prev.parts = [...prevParts, ...currParts];
    } else {
      consolidated.push(c);
    }
  }

  const payload: Record<string, unknown> = {
    contents: consolidated,
  };

  if (norm.systemPrompt) {
    payload.systemInstruction = {
      parts: [{ text: norm.systemPrompt }],
    };
  }

  if (norm.tools && norm.tools.length > 0) {
    payload.tools = [
      {
        functionDeclarations: norm.tools.map((t) => ({
          name: t.function.name,
          ...(t.function.description ? { description: t.function.description } : {}),
          parameters: t.function.parameters ?? { type: 'object', properties: {} },
        })),
      },
    ];
  }

  const generationConfig: Record<string, unknown> = {};
  if (typeof norm.temperature === 'number') generationConfig.temperature = norm.temperature;
  if (typeof norm.maxTokens === 'number') generationConfig.maxOutputTokens = norm.maxTokens;
  if (typeof norm.topP === 'number') generationConfig.topP = norm.topP;
  if (typeof norm.topK === 'number') generationConfig.topK = norm.topK;
  if (norm.stopSequences && norm.stopSequences.length > 0) generationConfig.stopSequences = norm.stopSequences;

  if (Object.keys(generationConfig).length > 0) {
    payload.generationConfig = generationConfig;
  }

  return payload;
}

export function compileToOpenAIResponses(
  norm: NormalizedRequest,
  _steps?: PipelineStep[],
  _lossyFields?: string[],
  _warnings?: string[]
): Record<string, unknown> {
  const inputItems: Array<Record<string, unknown>> = [];

  for (const msg of norm.messages) {
    if (msg.role === 'system') continue;

    if (msg.role === 'tool') {
      inputItems.push({
        type: 'function_call_output',
        call_id: msg.tool_call_id,
        output: contentToString(msg.content),
      });
      continue;
    }

    if (msg.role === 'assistant') {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          inputItems.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          });
        }
      }
      const txt = contentToString(msg.content);
      if (txt.trim()) {
        inputItems.push({ role: 'assistant', content: txt });
      }
      continue;
    }

    // User turn
    inputItems.push({
      role: 'user',
      content: contentToString(msg.content),
    });
  }

  const payload: Record<string, unknown> = {
    model: norm.model ?? 'gpt-4o',
    input: inputItems,
  };

  if (norm.systemPrompt) {
    payload.instructions = norm.systemPrompt;
  }

  if (norm.tools && norm.tools.length > 0) {
    payload.tools = norm.tools.map((t) => ({
      type: 'function',
      name: t.function.name,
      ...(t.function.description ? { description: t.function.description } : {}),
      parameters: t.function.parameters ?? { type: 'object', properties: {} },
    }));
  }

  if (typeof norm.temperature === 'number') payload.temperature = norm.temperature;
  if (typeof norm.maxTokens === 'number') payload.max_output_tokens = norm.maxTokens;

  return payload;
}

// ---------------------------------------------------------------------------
// Streaming SSE Chunk Conversions
// ---------------------------------------------------------------------------

export function convertSseOpenAIToAnthropic(
  chunk: Record<string, any>,
  steps: PipelineStep[]
): Record<string, unknown> {
  steps.push({
    step: 1,
    name: 'SSE Chunk Ingestion',
    status: 'ok',
    title: 'OpenAI SSE Chunk Ingested',
    details: `Ingested chunk object '${chunk.object ?? 'chat.completion.chunk'}' from model '${chunk.model ?? 'unknown'}'.`,
  });

  const choice = Array.isArray(chunk.choices) && chunk.choices[0] ? chunk.choices[0] : {};
  const delta = choice.delta || {};
  const content = delta.content || '';

  steps.push({
    step: 4,
    name: 'Streaming Delta Extraction',
    status: 'ok',
    title: 'Extracted Delta Content',
    details: content ? `Extracted text delta of ${content.length} characters.` : 'Choice finish or tool call delta.',
  });

  if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
    const tc = delta.tool_calls[0];
    return {
      type: 'content_block_delta',
      index: tc.index ?? 0,
      delta: {
        type: 'input_json_delta',
        partial_json: tc.function?.arguments ?? '',
      },
    };
  }

  if (choice.finish_reason) {
    return {
      type: 'message_delta',
      delta: {
        stop_reason: choice.finish_reason === 'stop' ? 'end_turn' : choice.finish_reason,
        stop_sequence: null,
      },
      usage: {
        output_tokens: 1,
      },
    };
  }

  return {
    type: 'content_block_delta',
    index: choice.index ?? 0,
    delta: {
      type: 'text_delta',
      text: content,
    },
  };
}

export function convertSseAnthropicToOpenAI(
  event: Record<string, any>,
  steps: PipelineStep[]
): Record<string, unknown> {
  steps.push({
    step: 1,
    name: 'SSE Chunk Ingestion',
    status: 'ok',
    title: 'Anthropic Event Ingested',
    details: `Ingested event type '${event.type ?? 'content_block_delta'}'.`,
  });

  if (event.type === 'content_block_delta') {
    const delta = event.delta || {};
    const text = delta.type === 'text_delta' ? delta.text ?? '' : '';
    const partialJson = delta.type === 'input_json_delta' ? delta.partial_json ?? '' : '';

    return {
      id: randomId('chatcmpl'),
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      choices: [
        {
          index: event.index ?? 0,
          delta: text
            ? { content: text }
            : partialJson
              ? {
                  tool_calls: [
                    {
                      index: event.index ?? 0,
                      function: { arguments: partialJson },
                    },
                  ],
                }
              : {},
          finish_reason: null,
        },
      ],
    };
  }

  if (event.type === 'message_delta') {
    const stopReason = event.delta?.stop_reason;
    return {
      id: randomId('chatcmpl'),
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: stopReason === 'end_turn' ? 'stop' : stopReason ?? 'stop',
        },
      ],
    };
  }

  return {
    id: randomId('chatcmpl'),
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: null,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Orchestrator: 7-Step Pipeline Inspection
// ---------------------------------------------------------------------------

export function inspectTranslation(
  sourceProtocol: ProtocolType,
  targetProtocol: ProtocolType,
  payload: Record<string, any>
): TranslationResult {
  const steps: PipelineStep[] = [];
  const lossyFields: string[] = [];
  const warnings: string[] = [];

  // Handle SSE streaming protocols
  if (sourceProtocol === 'sse_openai' || sourceProtocol === 'sse_anthropic' ||
      targetProtocol === 'sse_openai' || targetProtocol === 'sse_anthropic') {
    let transformed: Record<string, unknown> = {};

    if (sourceProtocol === 'sse_openai' && targetProtocol === 'sse_anthropic') {
      transformed = convertSseOpenAIToAnthropic(payload, steps);
    } else if (sourceProtocol === 'sse_anthropic' && targetProtocol === 'sse_openai') {
      transformed = convertSseAnthropicToOpenAI(payload, steps);
    } else {
      transformed = payload;
      steps.push({
        step: 1,
        name: 'SSE Passthrough',
        status: 'ok',
        title: 'Passthrough SSE stream event',
        details: 'Source and target streaming protocol match.',
      });
    }

    steps.push({
      step: 7,
      name: 'Target Assembly & Token Estimation',
      status: 'ok',
      title: 'SSE Chunk Assembly Complete',
      details: 'Assembled compliant streaming SSE event chunk.',
    });

    return {
      success: true,
      sourceProtocol,
      targetProtocol,
      transformed,
      steps,
      stats: {
        sourceTokens: 1,
        targetTokens: 1,
        delta: 0,
        warnings,
        lossyFields,
      },
    };
  }

  // 1. Ingestion Phase
  let norm: NormalizedRequest;
  switch (sourceProtocol) {
    case 'anthropic':
      norm = ingestAnthropic(payload, steps, lossyFields, warnings);
      break;
    case 'gemini':
      norm = ingestGemini(payload, steps, lossyFields, warnings);
      break;
    case 'openai_responses':
      norm = ingestOpenAIResponses(payload, steps, lossyFields, warnings);
      break;
    case 'openai_chat':
    default:
      norm = ingestOpenAIChat(payload, steps, lossyFields, warnings);
      break;
  }

  // 2. Compilation Phase
  let transformed: Record<string, unknown>;
  switch (targetProtocol) {
    case 'anthropic':
      transformed = compileToAnthropic(norm, steps, lossyFields, warnings);
      break;
    case 'gemini':
      transformed = compileToGemini(norm, steps, lossyFields, warnings);
      break;
    case 'openai_responses':
      transformed = compileToOpenAIResponses(norm, steps, lossyFields, warnings);
      break;
    case 'openai_chat':
    default:
      transformed = compileToOpenAIChat(norm, steps, lossyFields, warnings);
      break;
  }

  // Step 7: Assembly and Token Estimation
  const sourceTokens = estimateInputTokens(norm.messages, norm.tools);
  // Estimate target tokens
  let targetTokens = sourceTokens;
  try {
    const serialized = JSON.stringify(transformed);
    targetTokens = Math.ceil(serialized.length / 4);
  } catch {
    // fallback
  }

  steps.push({
    step: 7,
    name: 'Target Assembly & Token Estimation',
    status: warnings.length > 0 ? 'warn' : 'ok',
    title: 'Pipeline Transformation Complete',
    details: `Transformed payload assembled. Estimated ${targetTokens} tokens (source ~${sourceTokens} tokens, diff: ${targetTokens - sourceTokens}).`,
    metadata: {
      sourceTokens,
      targetTokens,
      delta: targetTokens - sourceTokens,
    },
  });

  return {
    success: true,
    sourceProtocol,
    targetProtocol,
    transformed,
    steps,
    stats: {
      sourceTokens,
      targetTokens,
      delta: targetTokens - sourceTokens,
      warnings,
      lossyFields,
    },
  };
}
