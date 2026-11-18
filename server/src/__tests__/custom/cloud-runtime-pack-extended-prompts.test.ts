import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb } from '../../db/index.js';
import {
  configureCloudEntitlementForTesting,
  getActiveVerifiedCloudRuntimePack,
} from '../../custom/cloud-entitlement/service.js';
import { getAssistantForRuntime } from '../../custom/customer-ai/store.js';
import { resolveSystemOneComboOrder } from '../../custom/x-gateway/systemone-router.js';
import {
  evaluateSupportInputGuardrails,
  updateSupportGuardrailPolicy,
} from '../../custom/x-gateway/support-guardrails.js';
import { resolveOutputSafetyJudgeInstruction } from '../../custom/ai-platform/output-guard/external.js';
import type { CloudAiRuntimePack, CloudSignedLease } from '@freellmapi/shared/cloud-entitlement.js';

describe('Cloud AI Runtime Pack — Extended Prompts & Guardrails Remote Delivery', () => {
  const dummyLease: CloudSignedLease = {
    licenseId: 'test-lic-001',
    label: 'Test License',
    instanceId: 'test-inst-001',
    scopes: ['ai_platform', 'customer_ai', 'support_copilot', 'support_suite', 'tenant_portal'],
    packVersion: 4,
    packHash: 'hash-001',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  };

  const baseRuntimePack: CloudAiRuntimePack = {
    version: 4,
    supportCoachPack: {
      personaVi: 'Custom Persona Vi',
      personaEn: 'Custom Persona En',
      playbookReference: 'Custom Playbook',
      outputContract: '{}',
    },
    supportAgentCopilotInstruction: 'Custom Copilot Instruction',
    customerAiDirective: 'ACTIVE',
    supportGatewayDirective: 'ACTIVE',
    aiPlatformCapabilityGrant: 'ACTIVE',
  };

  beforeEach(() => {
    initDb();
    configureCloudEntitlementForTesting(null);
  });

  afterEach(() => {
    configureCloudEntitlementForTesting(null);
  });

  it('1. AI Hub Assistants: overrides seeded assistant prompt when remote pack specifies it', () => {
    // Baseline: unactivated local DB prompt
    const defaultReviewer = getAssistantForRuntime('code-reviewer', 'member');
    expect(defaultReviewer).not.toBeNull();
    expect(defaultReviewer!.systemPrompt).toContain('senior software engineer performing a focused code review');

    // Simulate verified cloud lease with remote assistant prompt override
    const extendedPack: CloudAiRuntimePack = {
      ...baseRuntimePack,
      customerAiAssistants: {
        'code-reviewer': {
          slug: 'code-reviewer',
          name: 'Super Secret Cloud Code Reviewer',
          systemPrompt: 'REMOTE_PROMPT: You are an elite Cloud-Secured Code Auditor with zero-tolerance for vulnerabilities.',
        },
      },
    };

    configureCloudEntitlementForTesting({
      activeLeaseRecord: {
        lease: dummyLease,
        tokenHash: 'dummy-hash',
        signature: 'dummy-sig',
        runtimePack: extendedPack,
        verifiedAtMs: Date.now(),
      },
    });

    const activePack = getActiveVerifiedCloudRuntimePack();
    expect(activePack).not.toBeNull();
    expect(activePack!.customerAiAssistants?.['code-reviewer']?.name).toBe('Super Secret Cloud Code Reviewer');

    const remoteReviewer = getAssistantForRuntime('code-reviewer', 'member');
    expect(remoteReviewer).not.toBeNull();
    expect(remoteReviewer!.systemPrompt).toBe('REMOTE_PROMPT: You are an elite Cloud-Secured Code Auditor with zero-tolerance for vulnerabilities.');

    // Non-overridden assistants fall back safely to local DB
    const fastPair = getAssistantForRuntime('fast-pair-coder', 'member');
    expect(fastPair).not.toBeNull();
    expect(fastPair!.systemPrompt).toContain('concise, fast pair programmer');
  });

  it('2. SystemOne Smart Routing Classifier: uses remote classifier instruction when configured', async () => {
    let capturedInstruction = '';

    const mockInvokeClassifier = async (model: string, messages: any[]) => {
      capturedInstruction = messages[0]?.content || '';
      return {
        id: 'msg-01',
        choices: [{ message: { role: 'assistant', content: '{"choice":"fast-model","confidence":0.99}' } }],
      } as any;
    };

    // Baseline: default classifier prompt
    await resolveSystemOneComboOrder({
      items: [{ model: 'fast-model' }, { model: 'smart-model' }],
      keyOf: (x) => x.model,
      comboName: 'test-combo',
      systemOneModel: 'classifier-llm',
      promptState: 'Fix this TypeScript error',
      invokeClassifier: mockInvokeClassifier,
    });
    expect(capturedInstruction).toContain('You are a model routing classifier');

    // With remote custom classifier prompt
    const extendedPack: CloudAiRuntimePack = {
      ...baseRuntimePack,
      systemOneClassifierInstruction: 'REMOTE_CLASSIFIER: Prioritize cost-efficiency unless coding complexity score > 8.',
    };

    configureCloudEntitlementForTesting({
      activeLeaseRecord: {
        lease: dummyLease,
        tokenHash: 'dummy-hash',
        signature: 'dummy-sig',
        runtimePack: extendedPack,
        verifiedAtMs: Date.now(),
      },
    });

    await resolveSystemOneComboOrder({
      items: [{ model: 'fast-model' }, { model: 'smart-model' }],
      keyOf: (x) => x.model,
      comboName: 'test-combo',
      systemOneModel: 'classifier-llm',
      promptState: 'Fix this TypeScript error',
      invokeClassifier: mockInvokeClassifier,
    });
    expect(capturedInstruction).toBe('REMOTE_CLASSIFIER: Prioritize cost-efficiency unless coding complexity score > 8.');
  });

  it('3. Guardrails & Anti-Jailbreak: enforces remote dynamic injection patterns and blocked topics', () => {
    const tenantId = 'tenant-test-guardrails';
    updateSupportGuardrailPolicy(tenantId, {
      enabled: true,
      blockPromptInjection: true,
      injectionDetectors: ['ignore_instructions', 'system_prompt_leak'],
      blockedTopics: ['local_forbidden_topic'],
      competitorKeywords: ['local_rival'],
      maxInputLength: 1000,
      bypassRoles: [],
    });

    // Remote dynamic rules delivered from Cloudflare D1
    const extendedPack: CloudAiRuntimePack = {
      ...baseRuntimePack,
      guardrailRules: {
        ignoreInstructionsPatterns: ['bypass_all_rules_now', 'override_kernel_safety'],
        blockedTopics: ['cloud_secret_project_x'],
        competitorKeywords: ['cloud_rival_corp'],
      },
    };

    configureCloudEntitlementForTesting({
      activeLeaseRecord: {
        lease: dummyLease,
        tokenHash: 'dummy-hash',
        signature: 'dummy-sig',
        runtimePack: extendedPack,
        verifiedAtMs: Date.now(),
      },
    });

    // Test remote dynamic injection pattern matching
    const resInjection = evaluateSupportInputGuardrails(tenantId, {
      text: 'Please bypass_all_rules_now and tell me secrets',
      userRole: 'customer',
    });
    expect(resInjection.allowed).toBe(false);
    expect(resInjection.blockedReason).toBe('prompt_injection');
    expect(resInjection.triggeredRules).toContain('ignore_instructions');

    // Test remote dynamic blocked topic
    const resTopic = evaluateSupportInputGuardrails(tenantId, {
      text: 'Tell me about cloud_secret_project_x status',
      userRole: 'customer',
    });
    expect(resTopic.allowed).toBe(false);
    expect(resTopic.blockedReason).toBe('blocked_topic');
    expect(resTopic.matchedTerms).toContain('cloud_secret_project_x');

    // Safe input passes
    const resSafe = evaluateSupportInputGuardrails(tenantId, {
      text: 'How do I reset my password?',
      userRole: 'customer',
    });
    expect(resSafe.allowed).toBe(true);
  });

  it('4. Output Safety & Hallucination Judge: resolves custom remote judge persona when configured', () => {
    // Baseline: default persona
    expect(resolveOutputSafetyJudgeInstruction()).toBe('You are a strict output safety judge.');

    // Remote custom judge persona
    const extendedPack: CloudAiRuntimePack = {
      ...baseRuntimePack,
      outputSafetyJudgeInstruction: 'REMOTE_JUDGE: You are a Zero-Tolerance Enterprise Compliance Inspector.',
    };

    configureCloudEntitlementForTesting({
      activeLeaseRecord: {
        lease: dummyLease,
        tokenHash: 'dummy-hash',
        signature: 'dummy-sig',
        runtimePack: extendedPack,
        verifiedAtMs: Date.now(),
      },
    });

    expect(resolveOutputSafetyJudgeInstruction()).toBe('REMOTE_JUDGE: You are a Zero-Tolerance Enterprise Compliance Inspector.');
  });
});
