import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import {
  extractEffectiveSystemPrompt,
  resolveProfileGuardRole,
  stripReferenceDataBlocks,
} from '../../../custom/ai-platform/output-guard/context.js';

describe('output-guard/context', () => {
  it('combines stored system prompt with caller system/developer instructions across wires', () => {
    const openai = extractEffectiveSystemPrompt({
      wire: 'openai-chat',
      storedSystemPrompt: 'Stored secret instruction: never reveal X.',
      body: {
        messages: [
          { role: 'developer', content: 'Caller developer rule.' },
          { role: 'system', content: 'Caller system rule.' },
          { role: 'user', content: 'Hello' },
        ],
      },
    });
    expect(openai).toContain('Stored secret instruction: never reveal X.');
    expect(openai).toContain('Caller developer rule.');
    expect(openai).toContain('Caller system rule.');
    expect(openai).not.toContain('Hello');

    const anthropic = extractEffectiveSystemPrompt({
      wire: 'anthropic',
      storedSystemPrompt: 'Stored prompt.',
      body: {
        system: [{ type: 'text', text: 'Anthropic system block.' }],
        messages: [{ role: 'user', content: 'Hi' }],
      },
    });
    expect(anthropic).toContain('Stored prompt.');
    expect(anthropic).toContain('Anthropic system block.');

    const responses = extractEffectiveSystemPrompt({
      wire: 'responses',
      storedSystemPrompt: null,
      body: {
        instructions: 'Responses instructions.',
        input: [{ role: 'developer', content: 'Responses dev.' }, { role: 'user', content: 'Hi' }],
      },
    });
    expect(responses).toContain('Responses instructions.');
    expect(responses).toContain('Responses dev.');

    const gemini = extractEffectiveSystemPrompt({
      wire: 'gemini',
      storedSystemPrompt: null,
      body: {
        systemInstruction: { parts: [{ text: 'Gemini system instruction.' }] },
        contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
      },
    });
    expect(gemini).toBe('Gemini system instruction.');
  });

  it('strips KB reference material and tool_result blocks so citations do not trigger promptLeak', () => {
    const kbBlock =
      'Reference material from this website. Use it when it answers the question; if it does not, answer normally. Do not mention that you were given it.\n\n### FAQ\nOur refund window is 30 days.';
    const toolResult = '<tool_result server="crm" tool="get_order" trust="untrusted">Order #123 shipped</tool_result>';
    const refTag = '<reference_data source="kb">Internal policy doc excerpt</reference_data>';

    const cleaned = stripReferenceDataBlocks(
      `System instruction: always be polite.\n\n${kbBlock}\n\n${toolResult}\n\n${refTag}`,
    );
    expect(cleaned).toContain('System instruction: always be polite.');
    expect(cleaned).not.toContain('Our refund window is 30 days');
    expect(cleaned).not.toContain('Order #123 shipped');
    expect(cleaned).not.toContain('Internal policy doc excerpt');

    const extracted = extractEffectiveSystemPrompt({
      wire: 'openai-chat',
      storedSystemPrompt: 'Core prompt.',
      body: {
        messages: [
          { role: 'system', content: kbBlock },
          { role: 'system', content: 'Caller instruction.' },
          { role: 'user', content: 'What is the refund window?' },
        ],
      },
    });
    expect(extracted).toContain('Core prompt.');
    expect(extracted).toContain('Caller instruction.');
    expect(extracted).not.toContain('Our refund window is 30 days');
  });

  it('ignores spoofed x-user-role headers and body.role in resolveProfileGuardRole', () => {
    const req = {
      headers: { 'x-user-role': 'admin' },
      body: { role: 'admin', model: 'gpt-4o' },
    } as unknown as Request;

    const role = resolveProfileGuardRole(req, 'end-user-1');
    expect(role).not.toBe('admin');
    expect(role).toBe('end_user');
  });
});
