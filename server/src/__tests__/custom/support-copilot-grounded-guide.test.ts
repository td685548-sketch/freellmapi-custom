import { beforeAll, describe, expect, it } from 'vitest';
import { tryGroundedGuideReply } from '../../custom/support-setup-copilot/grounded-guide.js';
import type { CopilotLlmCall } from '../../custom/support-setup-copilot/agent-loop.js';
import { looksLikeQuestionnaire } from '../../custom/support-setup-copilot/playbook.js';
import { initDb } from '../../db/index.js';
import { createUser, type SessionUser } from '../../services/auth.js';

const reply = (output: Record<string, unknown>): CopilotLlmCall => async () => ({
  output: output as never,
  modelUsed: 'fake',
  routeSource: 'main_gateway_loopback',
});

describe('looksLikeQuestionnaire — keep how-to steps, drop the robotic form', () => {
  it('allows numbered step-by-step instructions', () => {
    expect(looksLikeQuestionnaire('Làm như sau:\n1. Mở /thruline/providers\n2. Bấm Connect\n3. Chọn nhà cung cấp')).toBe(false);
  });
  it('rejects a numbered list of questions', () => {
    expect(looksLikeQuestionnaire('1. Tên thương hiệu của bạn là gì?\n2. Website của bạn là gì?\n3. Giọng điệu bạn muốn?')).toBe(true);
  });
  it('does not flag plain prose', () => {
    expect(looksLikeQuestionnaire('Bước 7 khoá domain CORS.')).toBe(false);
  });
});

describe('tryGroundedGuideReply', () => {
  let member: SessionUser;
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    initDb(':memory:');
    member = createUser('gg-member@example.com', 'UserPass123!', 'member');
  });
  const ask = (llmCall: CopilotLlmCall) =>
    tryGroundedGuideReply({ user: member, messages: [{ role: 'user', content: 'thêm nhà cung cấp ở đâu' }], locale: 'vi', llmCall });

  it('returns the model answer, including numbered steps, as a guide reply', async () => {
    const res = await ask(reply({ intent: 'guide', reply: '1. Mở /thruline/providers\n2. Bấm Connect', suggestedQuickReplies: ['Kiểm tra lại'] }));
    expect(res?.intent).toBe('guide');
    expect(res?.reply).toContain('/thruline/providers');
    expect(res?.suggestedQuickReplies).toEqual(['Kiểm tra lại']);
    expect(res?.usedFallback).toBe(false);
  });

  it('falls back (null) when the model proposes a setup, asks a questionnaire, or no route answers', async () => {
    expect(await ask(reply({ intent: 'propose_setup', reply: 'Đây là kế hoạch' }))).toBeNull();
    expect(await ask(reply({ intent: 'guide', reply: '1. Tên shop là gì?\n2. Web là gì?' }))).toBeNull();
    expect(await ask(async () => null)).toBeNull();
  });
});
