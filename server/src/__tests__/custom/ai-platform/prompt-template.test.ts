import { describe, expect, it } from 'vitest';
import {
  PROMPT_LIMITS,
  SYSTEM_PROMPT_VARIABLE_NAMES,
  type PromptVariable,
} from '@freellmapi/shared/ai-platform-prompts.js';
import {
  renderWith,
  sanitizeVariableValue,
  validateTemplate,
} from '../../../custom/ai-platform/prompts/template.js';

describe('prompts/template', () => {
  describe('sanitizeVariableValue', () => {
    it('strips C0, DEL, and C1 control characters while preserving normal text', () => {
      const input = 'Alice\x00\x07\t\n\r\x1b[31m\x1f Nguyen\x7f\u0080\u009f!';
      expect(sanitizeVariableValue(input)).toBe('Alice[31m Nguyen!');
    });

    it('truncates values to PROMPT_LIMITS.maxCallerVarValueChars (200) after stripping control chars', () => {
      const prefixControls = '\x00\n\r\t\x1b\x7f\u009f';
      const body = 'a'.repeat(195) + 'b'.repeat(20);
      const out = sanitizeVariableValue(prefixControls + body);

      expect(out).toHaveLength(PROMPT_LIMITS.maxCallerVarValueChars);
      expect(out).toBe('a'.repeat(195) + 'b'.repeat(5));
    });

    it('preserves spaces, punctuation, and unicode characters within the limit', () => {
      const text = 'Xin chào, Nguyễn Văn A (tier: VIP #1)!';
      expect(sanitizeVariableValue(text)).toBe(text);
      expect(sanitizeVariableValue('\x00\n\x7f\u009f')).toBe('');
    });
  });

  describe('validateTemplate', () => {
    it('accepts plain templates, system variables, and valid declared variables', () => {
      const declared: PromptVariable[] = [
        { name: 'date', source: 'system' },
        { name: 'customer_tier', source: 'caller', default: 'standard' },
        { name: 'brand_voice', source: 'custom', default: '' },
      ];

      expect(validateTemplate('', declared)).toEqual({ ok: true });
      expect(
        validateTemplate(
          'Today is {{date}} for {{profile_name}} ({{end_user_id}} / {{end_user_name}} / {{language}}). Tier: {{customer_tier|free}}. Voice: {{brand_voice|}}.',
          declared,
        ),
      ).toEqual({ ok: true });
    });

    it('enforces variable name regex ^[a-z][a-z0-9_]{0,31}$', () => {
      const max32 = `a${'b0_'.repeat(10)}c`; // 1 + 30 + 1 = 32 chars
      expect(max32).toHaveLength(32);

      expect(
        validateTemplate('{{a}} and {{' + max32 + '|ok}}', [
          { name: 'a', source: 'caller' },
          { name: max32, source: 'custom' },
        ]),
      ).toEqual({ ok: true });

      const invalidNames = [
        'Foo',
        'fooBar',
        '1foo',
        '_foo',
        'foo-bar',
        `${max32}z`, // 33 chars
      ];

      for (const badName of invalidNames) {
        expect(validateTemplate(`{{${badName}}}`, [])).toMatchObject({
          ok: false,
          line: 1,
          column: 1,
        });
        expect(validateTemplate('ok', [{ name: badName, source: 'caller' }])).toMatchObject({
          ok: false,
          line: 1,
          column: 1,
        });
      }

      expect(validateTemplate('{{}}', [])).toMatchObject({ ok: false, line: 1, column: 1 });
      expect(validateTemplate('{{|fallback}}', [])).toMatchObject({
        ok: false,
        line: 1,
        column: 1,
      });
      expect(validateTemplate('{{ date }}', [])).toMatchObject({ ok: false, line: 1, column: 1 });
      expect(validateTemplate('{{date | 2026}}', [])).toMatchObject({
        ok: false,
        line: 1,
        column: 1,
      });
    });

    it('rejects duplicate, unknown system, and reserved-name non-system declarations', () => {
      expect(
        validateTemplate('ok', [
          { name: 'tier', source: 'caller' },
          { name: 'tier', source: 'custom' },
        ]),
      ).toMatchObject({ ok: false, line: 1, column: 1 });

      expect(
        validateTemplate('ok', [{ name: 'not_a_system_var', source: 'system' }]),
      ).toMatchObject({ ok: false, line: 1, column: 1 });

      for (const sysName of SYSTEM_PROMPT_VARIABLE_NAMES) {
        expect(validateTemplate('ok', [{ name: sysName, source: 'caller' }])).toMatchObject({
          ok: false,
          line: 1,
          column: 1,
        });
        expect(validateTemplate('ok', [{ name: sysName, source: 'custom' }])).toMatchObject({
          ok: false,
          line: 1,
          column: 1,
        });
      }
    });

    it('reports exact 1-based line and column across LF and CRLF multiline templates', () => {
      expect(validateTemplate('Line 1\n  {{unclosed', [])).toMatchObject({
        ok: false,
        line: 2,
        column: 3,
      });

      expect(validateTemplate('Line 1\r\nLine 2\r\n   }}', [])).toMatchObject({
        ok: false,
        line: 3,
        column: 4,
      });

      expect(validateTemplate('First\n{{date {{language}}}}', [])).toMatchObject({
        ok: false,
        line: 2,
        column: 8,
      });

      expect(validateTemplate('First\r\n  {{ bad_space }}', [])).toMatchObject({
        ok: false,
        line: 2,
        column: 3,
      });

      expect(validateTemplate('Line 1\nLine 2\n    {{khong_ton_tai}}', [])).toEqual({
        ok: false,
        line: 3,
        column: 5,
        reason: 'Undeclared variable: khong_ton_tai',
      });
    });

    it('handles triple braces and normal inline defaults cleanly', () => {
      expect(validateTemplate('{{{date}}}', [])).toMatchObject({
        ok: false,
        line: 1,
        column: 1,
      });

      expect(validateTemplate('JSON: {{date}}}', [])).toEqual({ ok: true });
      expect(
        validateTemplate('Note: {{topic|a | b, c: d!}}', [{ name: 'topic', source: 'caller' }]),
      ).toEqual({ ok: true });
    });
  });

  describe('renderWith', () => {
    it('returns the exact same string reference when template contains no "{{"', () => {
      const plain = 'You are a helpful assistant.\nUse {json} safely.';
      const result = renderWith(plain, { date: '2026-11-16' }, []);
      expect(result.missing).toEqual([]);
      expect(Object.is(result.rendered, plain)).toBe(true);

      const empty = '';
      const emptyResult = renderWith(empty, {}, []);
      expect(emptyResult.missing).toEqual([]);
      expect(Object.is(emptyResult.rendered, empty)).toBe(true);
    });

    it('applies precedence: values > inline default > declared default > missing', () => {
      const declared: PromptVariable[] = [
        { name: 'a', source: 'caller', default: 'decl_a' },
        { name: 'b', source: 'caller', default: 'decl_b' },
        { name: 'c', source: 'caller', default: 'decl_c' },
        { name: 'd', source: 'caller', default: '' },
        { name: 'e', source: 'caller' },
        { name: 'f', source: 'caller' },
      ];

      const template =
        '1={{a|inline_a}} 2={{b|inline_b}} 3={{c}} 4={{d}} 5={{e|}} 6={{f}} 7={{e}} 8={{f}}';

      const result = renderWith(
        template,
        {
          a: 'val_a',
          b: '', // empty string falls through to inline_b
        },
        declared,
      );

      expect(result.rendered).toBe(
        '1=val_a 2=inline_b 3=decl_c 4= 5= 6= 7= 8=',
      );
      expect(result.missing).toEqual(['f', 'e']);
    });

    it('ignores prototype-inherited keys on values and tracks unique missing variables in order', () => {
      const values = Object.create({ inherited_var: 'from_proto' }) as Record<string, string>;
      values.alpha = '';

      const result = renderWith(
        '{{inherited_var}}|{{alpha}}|{{beta}}|{{alpha}}|{{inherited_var}}',
        values,
        [],
      );

      expect(result.rendered).toBe('||||');
      expect(result.missing).toEqual(['inherited_var', 'alpha', 'beta']);
    });

    it('performs single-pass substitution without re-expanding {{...}} inside values or defaults', () => {
      const declared: PromptVariable[] = [
        { name: 'user_note', source: 'caller' },
        { name: 'foo', source: 'custom', default: 'literal {{date}}' },
      ];

      const result = renderWith(
        'Date={{date}}; Note={{user_note}}; Decl={{foo}}; After={{date}}',
        {
          date: '2026-11-16',
          user_note: 'Inject {{date}} and {{foo}}',
        },
        declared,
      );

      expect(result.rendered).toBe(
        'Date=2026-11-16; Note=Inject {{date}} and {{foo}}; Decl=literal {{date}}; After=2026-11-16',
      );
      expect(result.missing).toEqual([]);
    });

    it('sanitizes and truncates caller/runtime values during substitution', () => {
      const longDirty = '\x00\n\x1b' + 'x'.repeat(210) + '\x7f\u009f';
      const result = renderWith(
        'V={{note}}',
        { note: longDirty },
        [{ name: 'note', source: 'caller' }],
      );

      expect(result.rendered).toBe(`V=${'x'.repeat(PROMPT_LIMITS.maxCallerVarValueChars)}`);
      expect(result.missing).toEqual([]);
    });
  });
});
