import { describe, expect, it, beforeAll } from 'vitest';
import {
  detectRequiredCapabilities,
  looksLikeVisionModel,
  looksLikeAudioModel,
  getCapacityAdapterSettings,
  setCapacityAdapterSettings,
  augmentCandidatesWithCapacityAdapter,
} from '../../custom/x-gateway/capacity-adapter.js';
import { initDb } from '../../db/index.js';

describe('X Gateway Capacity Adapter', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    initDb(':memory:');
  });

  describe('Capability detection', () => {
    it('detects text-only messages as requiring neither vision nor audio', () => {
      const messages = [
        { role: 'user' as const, content: 'Hello, what is 2 + 2?' },
        { role: 'assistant' as const, content: 'It is 4.' },
      ];
      const caps = detectRequiredCapabilities(messages);
      expect(caps.vision).toBe(false);
      expect(caps.audioInput).toBe(false);
    });

    it('detects image_url parts in multipart content as requiring vision', () => {
      const messages = [
        {
          role: 'user' as const,
          content: [
            { type: 'text', text: 'Describe this image' },
            { type: 'image_url', image_url: { url: 'https://example.com/test.png' } },
          ] as any,
        },
      ];
      const caps = detectRequiredCapabilities(messages);
      expect(caps.vision).toBe(true);
      expect(caps.audioInput).toBe(false);
    });

    it('detects base64 data:image strings as requiring vision', () => {
      const messages = [
        { role: 'user' as const, content: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' },
      ];
      const caps = detectRequiredCapabilities(messages);
      expect(caps.vision).toBe(true);
    });

    it('detects audio input parts as requiring audioInput', () => {
      const messages = [
        {
          role: 'user' as const,
          content: [
            { type: 'input_audio', input_audio: { data: 'base64audio', format: 'mp3' } },
          ] as any,
        },
      ];
      const caps = detectRequiredCapabilities(messages);
      expect(caps.audioInput).toBe(true);
    });
  });

  describe('Model Capability Recognition', () => {
    it('correctly identifies vision-capable models', () => {
      expect(looksLikeVisionModel('gpt-4o')).toBe(true);
      expect(looksLikeVisionModel('gpt-4o-mini')).toBe(true);
      expect(looksLikeVisionModel('claude-3-5-sonnet-20241022')).toBe(true);
      expect(looksLikeVisionModel('gemini-1.5-pro')).toBe(true);
      expect(looksLikeVisionModel('qwen-2.5-vl-72b')).toBe(true);
      expect(looksLikeVisionModel('mimo-v2.6-flash-free')).toBe(true);

      // Non-vision
      expect(looksLikeVisionModel('llama-3.3-70b-instruct')).toBe(false);
      expect(looksLikeVisionModel('deepseek-r1')).toBe(false);
      expect(looksLikeVisionModel('deepseek-chat')).toBe(false);
    });

    it('correctly identifies audio models', () => {
      expect(looksLikeAudioModel('gpt-4o-audio-preview')).toBe(true);
      expect(looksLikeAudioModel('whisper-large-v3')).toBe(true);
      expect(looksLikeAudioModel('llama-3-8b')).toBe(false);
    });
  });

  describe('Configuration Persistence', () => {
    it('returns default capacity adapter when unconfigured', () => {
      const settings = getCapacityAdapterSettings();
      expect(settings.vision.enabled).toBe(true);
      expect(settings.vision.models).toContain('oc/mimo-v2.6-flash-free');
    });

    it('saves and reads customized capacity adapter settings', () => {
      setCapacityAdapterSettings({
        vision: {
          enabled: true,
          roundRobin: true,
          models: ['groq/llama-3.2-11b-vision-preview', 'oc/mimo-v2.6-flash-free'],
        },
        audioInput: {
          enabled: true,
          roundRobin: false,
          models: ['openai/gpt-4o-audio-preview'],
        },
      });

      const updated = getCapacityAdapterSettings();
      expect(updated.vision.roundRobin).toBe(true);
      expect(updated.vision.models).toHaveLength(2);
      expect(updated.audioInput.enabled).toBe(true);
    });
  });

  describe('Augmentation behavior', () => {
    it('leaves candidates untouched if request has no vision and no audio requirements', () => {
      const candidates = [
        { account: { id: 1, provider: 'groq' } as any, modelId: 'llama-3.3-70b' },
      ];
      const messages = [{ role: 'user' as const, content: 'Just text prompt' }];
      const augmented = augmentCandidatesWithCapacityAdapter(candidates, messages);
      expect(augmented).toEqual(candidates);
    });

    it('leaves candidates untouched if existing candidate already supports vision', () => {
      const candidates = [
        { account: { id: 1, provider: 'openai' } as any, modelId: 'gpt-4o' },
      ];
      const messages = [
        {
          role: 'user' as const,
          content: [
            { type: 'text', text: 'Hi' },
            { type: 'image_url', image_url: { url: 'https://example.com/img.jpg' } },
          ] as any,
        },
      ];
      const augmented = augmentCandidatesWithCapacityAdapter(candidates, messages);
      expect(augmented).toEqual(candidates);
    });
  });
});

