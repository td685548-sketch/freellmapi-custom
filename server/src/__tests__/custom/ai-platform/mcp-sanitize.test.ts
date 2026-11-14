import { describe, expect, it } from 'vitest';
import {
  assertSafeToolSchema,
  sanitizeMcpError,
  sanitizeMcpText,
  sanitizeMcpValue,
  scrubCredentialEcho,
  scrubSensitiveKeys,
} from '../../../custom/ai-platform/mcp-client/sanitize.js';

describe('MCP sanitizer (F02)', () => {
  it('redacts opaque credentials without sk-/Bearer prefix in text, nested objects, and errors', () => {
    const opaqueCred = 'vault-opaque-987654321-xyz';

    expect(scrubCredentialEcho(`Server rejected ${opaqueCred} at header`, [opaqueCred])).toBe(
      'Server rejected [REDACTED] at header',
    );
    expect(sanitizeMcpText(`echo=${opaqueCred} email=alice@example.com`, [opaqueCred])).not.toContain(
      opaqueCred,
    );
    expect(sanitizeMcpText(`echo=${opaqueCred} email=alice@example.com`, [opaqueCred])).not.toContain(
      'alice@example.com',
    );

    const scrubbed = scrubSensitiveKeys(
      {
        name: 'echo-mcp',
        authorization: 'should-redact',
        nested: {
          api_key: '123456',
          banner: `Connected with ${opaqueCred}`,
        },
        list: [opaqueCred, 'ok'],
      },
      [opaqueCred],
    ) as Record<string, unknown>;

    expect(scrubbed.authorization).toBe('[REDACTED]');
    expect((scrubbed.nested as Record<string, unknown>).api_key).toBe('[REDACTED]');
    expect((scrubbed.nested as Record<string, unknown>).banner).toBe('Connected with [REDACTED]');
    expect(scrubbed.list).toEqual(['[REDACTED]', 'ok']);
    expect(JSON.stringify(sanitizeMcpValue(scrubbed, [opaqueCred]))).not.toContain(opaqueCred);

    const errMsg = sanitizeMcpError(new Error(`Upstream failed: ${opaqueCred}`), [opaqueCred]);
    expect(errMsg).not.toContain(opaqueCred);
    expect(errMsg).toContain('[REDACTED]');
  });

  it('rejects tool schemas or descriptions echoing credentials without mutating enum/required semantics', () => {
    const opaqueCred = 'opaque-cred-alpha-777888';
    const schemaWithEcho = {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['safe', opaqueCred],
        },
      },
      required: ['mode'],
    };

    const res = assertSafeToolSchema(schemaWithEcho, 'Reads item', [opaqueCred]);
    expect(res.ok).toBe(false);
    // Schema itself must not be mutated
    expect((schemaWithEcho.properties.mode.enum as string[])[1]).toBe(opaqueCred);

    const descEcho = assertSafeToolSchema(
      { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      `Uses ${opaqueCred} internally`,
      [opaqueCred],
    );
    expect(descEcho.ok).toBe(false);

    const clean = assertSafeToolSchema(
      { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      'Clean read tool',
      [opaqueCred],
    );
    expect(clean.ok).toBe(true);
  });
});
