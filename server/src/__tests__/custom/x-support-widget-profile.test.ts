import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SUPPORT_DESK_WIDGET_CONFIG,
  RESERVED_INTAKE_FIELD_KEYS,
  SUPPORT_DESK_LIMITS,
} from '@freellmapi/shared/support-service-desk.js';
import {
  computeSupportDeskIntakeSchemaHash,
  projectSupportDeskWidgetConfig,
  SupportDeskError,
  validateSupportDeskIntake,
  validateWidgetConfigPatch,
} from '../../custom/x-gateway/support-widget-profile.js';

describe('support-widget-profile', () => {
  it('projects default-off widget config without secrets and with deterministic schemaHash', () => {
    const pub = projectSupportDeskWidgetConfig(DEFAULT_SUPPORT_DESK_WIDGET_CONFIG);
    expect(pub.enabled).toBe(false);
    expect(pub.version).toBe(1);
    expect(pub.appearance.primaryColor).toBe('#2563eb');
    expect(pub.intake.required).toBe(false);
    expect(pub.intake.fields).toEqual([]);
    expect(pub.intake.schemaHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('appearance-only edits do not change intake schemaHash', () => {
    const withIntake = validateWidgetConfigPatch(
      DEFAULT_SUPPORT_DESK_WIDGET_CONFIG,
      {
        enabled: true,
        intake: {
          required: true,
          fields: [{ key: 'topic', label: 'Topic', type: 'text', required: true }],
        },
      },
      '2026-11-13T00:00:00.000Z',
    );
    const hashBefore = computeSupportDeskIntakeSchemaHash(withIntake);

    const appearanceEdited = validateWidgetConfigPatch(
      withIntake,
      {
        appearance: {
          primaryColor: '#dc2626',
          title: 'Updated Title',
          welcomeMessage: 'Hello!',
          position: 'bottom-left',
          quickPrompts: ['Help me'],
        },
      },
      '2026-11-13T00:01:00.000Z',
    );
    expect(computeSupportDeskIntakeSchemaHash(appearanceEdited)).toBe(hashBefore);
  });

  it('rejects invalid hex colors, HTML/URL injection, and duplicate quickPrompts', () => {
    expect(() =>
      validateWidgetConfigPatch(
        DEFAULT_SUPPORT_DESK_WIDGET_CONFIG,
        {
          appearance: {
            primaryColor: 'red',
            title: 'Support',
            welcomeMessage: '',
            position: 'bottom-right',
            quickPrompts: [],
          },
        },
        '2026-11-13T00:00:00.000Z',
      ),
    ).toThrow(SupportDeskError);

    expect(() =>
      validateWidgetConfigPatch(
        DEFAULT_SUPPORT_DESK_WIDGET_CONFIG,
        {
          appearance: {
            primaryColor: '#2563eb',
            title: '<script>alert(1)</script>',
            welcomeMessage: '',
            position: 'bottom-right',
            quickPrompts: [],
          },
        },
        '2026-11-13T00:00:00.000Z',
      ),
    ).toThrow(SupportDeskError);

    expect(() =>
      validateWidgetConfigPatch(
        DEFAULT_SUPPORT_DESK_WIDGET_CONFIG,
        {
          appearance: {
            primaryColor: '#2563eb',
            title: 'Support',
            welcomeMessage: 'Visit https://evil.example',
            position: 'bottom-right',
            quickPrompts: [],
          },
        },
        '2026-11-13T00:00:00.000Z',
      ),
    ).toThrow(SupportDeskError);

    expect(() =>
      validateWidgetConfigPatch(
        DEFAULT_SUPPORT_DESK_WIDGET_CONFIG,
        {
          appearance: {
            primaryColor: '#2563eb',
            title: 'Support',
            welcomeMessage: '',
            position: 'bottom-right',
            quickPrompts: ['Same', 'Same'],
          },
        },
        '2026-11-13T00:00:00.000Z',
      ),
    ).toThrow(SupportDeskError);
  });

  it('rejects reserved/prototype field keys and invalid required=true combinations', () => {
    for (const reserved of RESERVED_INTAKE_FIELD_KEYS) {
      const payload = JSON.parse(
        `{"enabled":true,"intake":{"required":false,"fields":[{"key":"${reserved}","label":"X","type":"text","required":false}]}}`,
      );
      expect(() =>
        validateWidgetConfigPatch(
          DEFAULT_SUPPORT_DESK_WIDGET_CONFIG,
          payload,
          '2026-11-13T00:00:00.000Z',
        ),
      ).toThrow(SupportDeskError);
    }

    // required=true when enabled=false
    expect(() =>
      validateWidgetConfigPatch(
        DEFAULT_SUPPORT_DESK_WIDGET_CONFIG,
        {
          enabled: false,
          intake: {
            required: true,
            fields: [{ key: 'name', label: 'Name', type: 'text', required: true }],
          },
        },
        '2026-11-13T00:00:00.000Z',
      ),
    ).toThrow(SupportDeskError);

    // required=true when no field has required=true
    expect(() =>
      validateWidgetConfigPatch(
        DEFAULT_SUPPORT_DESK_WIDGET_CONFIG,
        {
          enabled: true,
          intake: {
            required: true,
            fields: [{ key: 'name', label: 'Name', type: 'text', required: false }],
          },
        },
        '2026-11-13T00:00:00.000Z',
      ),
    ).toThrow(SupportDeskError);
  });

  it('validates text/email/number/select intake values strictly without numeric string coercion', () => {
    const cfg = validateWidgetConfigPatch(
      DEFAULT_SUPPORT_DESK_WIDGET_CONFIG,
      {
        enabled: true,
        intake: {
          required: true,
          fields: [
            { key: 'full_name', label: 'Name', type: 'text', required: true },
            { key: 'contact_email', label: 'Email', type: 'email', required: true },
            { key: 'order_count', label: 'Count', type: 'number', required: false },
            { key: 'plan', label: 'Plan', type: 'select', required: true, options: ['free', 'pro'] },
          ],
        },
      },
      '2026-11-13T00:00:00.000Z',
    );

    const valid = validateSupportDeskIntake(cfg, {
      full_name: '  Alice  ',
      contact_email: 'alice@example.com',
      order_count: 3,
      plan: 'pro',
    });
    expect(valid).toEqual({
      full_name: 'Alice',
      contact_email: 'alice@example.com',
      order_count: 3,
      plan: 'pro',
    });

    // Reject numeric string coercion
    expect(() =>
      validateSupportDeskIntake(cfg, {
        full_name: 'Alice',
        contact_email: 'alice@example.com',
        order_count: '3',
        plan: 'pro',
      }),
    ).toThrow(SupportDeskError);

    // Reject unknown field and invalid email
    try {
      validateSupportDeskIntake(cfg, {
        full_name: 'Alice',
        contact_email: 'not-an-email',
        plan: 'enterprise',
        extra: 'bad',
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SupportDeskError);
      const sdErr = err as SupportDeskError;
      expect(sdErr.code).toBe('invalid_intake');
      expect(sdErr.fields).toEqual({
        extra: 'unknown_field',
        contact_email: 'invalid_email',
        plan: 'invalid_option',
      });
    }

    // Reject oversized intake payload
    expect(() =>
      validateSupportDeskIntake(cfg, {
        full_name: 'a'.repeat(SUPPORT_DESK_LIMITS.maxIntakeBytes),
        contact_email: 'alice@example.com',
        plan: 'free',
      }),
    ).toThrow(SupportDeskError);
  });

  it('rejects options on non-select fields, empty/duplicate select options, and >10 fields', () => {
    expect(() =>
      validateWidgetConfigPatch(
        DEFAULT_SUPPORT_DESK_WIDGET_CONFIG,
        {
          enabled: true,
          intake: {
            required: false,
            fields: [{ key: 'name', label: 'Name', type: 'text', required: false, options: ['a'] }],
          },
        },
        '2026-11-13T00:00:00.000Z',
      ),
    ).toThrow(SupportDeskError);

    expect(() =>
      validateWidgetConfigPatch(
        DEFAULT_SUPPORT_DESK_WIDGET_CONFIG,
        {
          enabled: true,
          intake: {
            required: false,
            fields: [{ key: 'tier', label: 'Tier', type: 'select', required: false, options: ['a', 'a'] }],
          },
        },
        '2026-11-13T00:00:00.000Z',
      ),
    ).toThrow(SupportDeskError);

    const elevenFields = Array.from({ length: SUPPORT_DESK_LIMITS.maxFields + 1 }, (_, i) => ({
      key: `f_${i}`,
      label: `Field ${i}`,
      type: 'text' as const,
      required: false,
    }));
    expect(() =>
      validateWidgetConfigPatch(
        DEFAULT_SUPPORT_DESK_WIDGET_CONFIG,
        { enabled: true, intake: { required: false, fields: elevenFields } },
        '2026-11-13T00:00:00.000Z',
      ),
    ).toThrow(SupportDeskError);
  });

  it('enforces number bounds (+/-1e9, finite) and email 254-char limit', () => {
    const cfg = validateWidgetConfigPatch(
      DEFAULT_SUPPORT_DESK_WIDGET_CONFIG,
      {
        enabled: true,
        intake: {
          required: false,
          fields: [
            { key: 'amount', label: 'Amount', type: 'number', required: false },
            { key: 'email', label: 'Email', type: 'email', required: false },
          ],
        },
      },
      '2026-11-13T00:00:00.000Z',
    );

    expect(() => validateSupportDeskIntake(cfg, { amount: 1e9 + 1 })).toThrow(SupportDeskError);
    expect(() => validateSupportDeskIntake(cfg, { amount: Number.NaN })).toThrow(SupportDeskError);
    expect(() =>
      validateSupportDeskIntake(cfg, { email: `${'a'.repeat(245)}@example.com` }),
    ).toThrow(SupportDeskError);
  });

  it('rejects unknown keys in widget config patch', () => {
    expect(() =>
      validateWidgetConfigPatch(
        DEFAULT_SUPPORT_DESK_WIDGET_CONFIG,
        { enabled: true, extraKey: 123 },
        '2026-11-13T00:00:00.000Z',
      ),
    ).toThrow(SupportDeskError);
  });
});
