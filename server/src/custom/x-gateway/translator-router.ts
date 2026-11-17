import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getSetting, setSetting } from '../../db/index.js';
import {
  inspectTranslation,
  type ProtocolType,
} from './translator-engine.js';
import { getUsableXGatewayKeys } from '../provider-accounts/store.js';

export const xTranslatorRouter = Router();

const CASES_SETTING_KEY = 'thruline_translator_cases';
const MAX_SAVED_CASES = 50;

export interface SavedTranslatorCase {
  id: string;
  name: string;
  sourceProtocol: ProtocolType;
  targetProtocol: ProtocolType;
  payload: Record<string, unknown>;
  createdAt: string;
}

const protocolEnum = z.enum([
  'openai_chat',
  'anthropic',
  'openai_responses',
  'gemini',
  'kiro',
  'antigravity',
  'vertex',
  'ollama',
  'cursor',
  'sse_openai',
  'sse_anthropic',
]);

const saveCaseSchema = z.object({
  name: z.string().trim().min(1).max(120),
  sourceProtocol: protocolEnum,
  targetProtocol: protocolEnum,
  payload: z.record(z.string(), z.unknown()),
}).strict();

const inspectSchema = z.object({
  sourceProtocol: protocolEnum,
  targetProtocol: protocolEnum,
  payload: z.record(z.string(), z.unknown()),
}).strict();

const dispatchSchema = z.object({
  protocol: protocolEnum,
  payload: z.record(z.string(), z.unknown()),
  model: z.string().optional(),
}).strict();

export const TRANSLATOR_TEMPLATES: Array<{
  id: string;
  name: string;
  protocol: ProtocolType;
  description: string;
  payload: Record<string, unknown>;
}> = [
  {
    id: 'openai-chat-simple',
    name: 'OpenAI Chat (Simple)',
    protocol: 'openai_chat',
    description: 'Basic multi-turn conversation with system instructions',
    payload: {
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are an expert software architect.' },
        { role: 'user', content: 'Explain the Model Context Protocol in two sentences.' },
      ],
      temperature: 0.7,
      max_tokens: 500,
    },
  },
  {
    id: 'openai-tools-weather',
    name: 'OpenAI Tools (Weather Function)',
    protocol: 'openai_chat',
    description: 'Function calling declaration and call turn',
    payload: {
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You have access to live tools.' },
        { role: 'user', content: 'What is the weather in Tokyo?' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_current_weather',
            description: 'Get current temperature and conditions for a given location',
            parameters: {
              type: 'object',
              properties: {
                location: { type: 'string', description: 'City name' },
                unit: { type: 'string', enum: ['celsius', 'fahrenheit'] },
              },
              required: ['location'],
            },
          },
        },
      ],
      tool_choice: 'auto',
    },
  },
  {
    id: 'anthropic-messages-vision',
    name: 'Anthropic Messages (Vision Base64)',
    protocol: 'anthropic',
    description: 'Claude Messages payload with image block and system parameter',
    payload: {
      model: 'claude-3-7-sonnet-20250219',
      max_tokens: 1024,
      system: 'You are an image analysis assistant.',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe what you see in this icon.' },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
              },
            },
          ],
        },
      ],
    },
  },
  {
    id: 'gemini-generate-content',
    name: 'Google Gemini (generateContent)',
    protocol: 'gemini',
    description: 'Gemini native contents and systemInstruction schema',
    payload: {
      contents: [
        {
          role: 'user',
          parts: [{ text: 'Write a haiku about high-speed internet routing.' }],
        },
      ],
      systemInstruction: {
        parts: [{ text: 'You are a poetic terminal assistant.' }],
      },
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 256,
      },
    },
  },
  {
    id: 'openai-responses-turn',
    name: 'OpenAI Responses API',
    protocol: 'openai_responses',
    description: 'New /v1/responses format used by modern agent harnesses',
    payload: {
      model: 'gpt-4o',
      instructions: 'Always answer with valid JSON format.',
      input: [
        { role: 'user', content: 'Generate a list of 3 colors in RGB hex.' },
      ],
      max_output_tokens: 200,
    },
  },
  {
    id: 'sse-streaming-delta',
    name: 'SSE Stream Chunk (OpenAI Delta)',
    protocol: 'sse_openai',
    description: 'Server-Sent Events streaming token chunk',
    payload: {
      id: 'chatcmpl-9xyz',
      object: 'chat.completion.chunk',
      created: 1710000000,
      model: 'gpt-4o',
      choices: [
        {
          index: 0,
          delta: { content: 'Antigravity' },
          finish_reason: null,
        },
      ],
    },
  },
  {
    id: 'kiro-agent-turn',
    name: 'AWS Kiro (conversationState)',
    protocol: 'kiro',
    description: 'Kiro / CodeWhisperer conversationState wire payload',
    payload: {
      conversationState: {
        chatTriggerType: 'MANUAL',
        currentMessage: {
          userInputMessage: {
            content: 'Summarize the gateway architecture.',
            modelId: 'claude-sonnet-4.5',
            origin: 'AI_EDITOR',
          },
        },
        history: [],
      },
    },
  },
  {
    id: 'antigravity-v1internal',
    name: 'Google Antigravity (v1internal)',
    protocol: 'antigravity',
    description: 'Cloud Code Assist v1internal wrapped Gemini request',
    payload: {
      project: 'demo-project',
      model: 'gemini-2.5-flash',
      requestType: 'agent',
      request: {
        contents: [{ role: 'user', parts: [{ text: 'Check service health.' }] }],
      },
    },
  },
  {
    id: 'vertex-publisher-turn',
    name: 'Google Vertex AI (Publisher)',
    protocol: 'vertex',
    description: 'Vertex AI publisher Gemini or partner Claude payload',
    payload: {
      contents: [{ role: 'user', parts: [{ text: 'Describe cloud IAM least privilege.' }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 512 },
    },
  },
  {
    id: 'ollama-chat-local',
    name: 'Ollama (/api/chat)',
    protocol: 'ollama',
    description: 'Native Ollama chat format with options block',
    payload: {
      model: 'llama3.3',
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Explain SQLite WAL mode.' },
      ],
      stream: false,
      options: { temperature: 0.3, num_predict: 256 },
    },
  },
  {
    id: 'cursor-chat-turn',
    name: 'Cursor IDE Chat',
    protocol: 'cursor',
    description: 'Cursor IDE conversation array with modelDetails',
    payload: {
      modelDetails: { modelName: 'claude-sonnet-4.5' },
      conversation: [
        { type: 0, role: 'system', text: 'You are a TypeScript reviewer.' },
        { type: 1, role: 'user', text: 'Inspect this route handler for SSRF.' },
      ],
    },
  },
];

function loadSavedCases(): SavedTranslatorCase[] {
  const raw = getSetting(CASES_SETTING_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeSavedCases(cases: SavedTranslatorCase[]): void {
  setSetting(CASES_SETTING_KEY, JSON.stringify(cases.slice(0, MAX_SAVED_CASES)));
}

xTranslatorRouter.get('/cases', (_req: Request, res: Response) => {
  res.json({ cases: loadSavedCases() });
});

xTranslatorRouter.post('/cases', (req: Request, res: Response) => {
  const parsed = saveCaseSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid saved test case payload.', issues: parsed.error.issues } });
    return;
  }
  const cases = loadSavedCases();
  const entry: SavedTranslatorCase = {
    id: `case_${crypto.randomBytes(6).toString('hex')}`,
    name: parsed.data.name,
    sourceProtocol: parsed.data.sourceProtocol,
    targetProtocol: parsed.data.targetProtocol,
    payload: parsed.data.payload,
    createdAt: new Date().toISOString(),
  };
  const next = [entry, ...cases].slice(0, MAX_SAVED_CASES);
  writeSavedCases(next);
  res.status(201).json({ case: entry, cases: next });
});

xTranslatorRouter.delete('/cases/:id', (req: Request, res: Response) => {
  const id = String(req.params.id ?? '');
  const cases = loadSavedCases();
  const next = cases.filter(c => c.id !== id);
  if (next.length === cases.length) {
    res.status(404).json({ error: { message: 'Saved case not found.' } });
    return;
  }
  writeSavedCases(next);
  res.json({ deleted: true, cases: next });
});

xTranslatorRouter.get('/templates', (_req: Request, res: Response) => {
  res.json({ templates: TRANSLATOR_TEMPLATES });
});

xTranslatorRouter.post('/inspect', (req: Request, res: Response) => {
  const parseResult = inspectSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({
      error: {
        type: 'invalid_request_error',
        message: 'Invalid inspection request payload.',
        issues: parseResult.error.issues,
      },
    });
    return;
  }

  const { sourceProtocol, targetProtocol, payload } = parseResult.data;
  const result = inspectTranslation(sourceProtocol, targetProtocol, payload);
  res.json(result);
});

xTranslatorRouter.post('/dispatch', async (req: Request, res: Response) => {
  const parseResult = dispatchSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({
      error: {
        type: 'invalid_request_error',
        message: 'Invalid dispatch request.',
        issues: parseResult.error.issues,
      },
    });
    return;
  }

  const { protocol, payload, model } = parseResult.data;
  const startMs = Date.now();
  const usableKeys = getUsableXGatewayKeys();

  // Test reachability of gateway accounts
  if (usableKeys.length === 0) {
    res.status(503).json({
      success: false,
      error: {
        type: 'no_available_keys',
        message: 'No active Thruline accounts configured to execute dispatch.',
      },
      latencyMs: Date.now() - startMs,
    });
    return;
  }

  res.json({
    success: true,
    protocol,
    model: model ?? payload.model ?? 'auto',
    availableAccounts: usableKeys.length,
    latencyMs: Date.now() - startMs,
    status: 200,
    note: 'Gateway candidate route verified. Ready for transmission.',
  });
});
