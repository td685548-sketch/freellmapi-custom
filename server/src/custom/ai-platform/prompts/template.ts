import {
  PROMPT_LIMITS,
  PROMPT_VAR_NAME_REGEX,
  SYSTEM_PROMPT_VARIABLE_NAMES,
  type PromptVariable,
} from '@freellmapi/shared/ai-platform-prompts.js';

export type TemplateValidationResult =
  | { ok: true }
  | { ok: false; line: number; column: number; reason: string };

export interface RenderTemplateResult {
  rendered: string;
  missing: string[];
}

function isControlCode(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

/**
 * Strips C0 (0x00-0x1F), DEL (0x7F), and C1 (0x80-0x9F) control characters
 * and truncates the result to PROMPT_LIMITS.maxCallerVarValueChars (200 chars).
 */
export function sanitizeVariableValue(raw: string): string {
  const input = typeof raw === 'string' ? raw : String(raw ?? '');
  const maxChars = PROMPT_LIMITS.maxCallerVarValueChars;
  let out = '';

  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (isControlCode(code)) {
      continue;
    }
    out += input[i];
    if (out.length >= maxChars) {
      break;
    }
  }

  return out;
}

function validateDeclaredVariables(
  declared: PromptVariable[],
): { ok: true; names: Set<string> } | { ok: false; reason: string } {
  const names = new Set<string>();

  for (const variable of declared) {
    if (!PROMPT_VAR_NAME_REGEX.test(variable.name)) {
      return {
        ok: false,
        reason: `Invalid variable name: ${variable.name}`,
      };
    }

    if (names.has(variable.name)) {
      return {
        ok: false,
        reason: `Duplicate variable declaration: ${variable.name}`,
      };
    }

    const isSystemName = SYSTEM_PROMPT_VARIABLE_NAMES.has(variable.name);
    if (variable.source === 'system' && !isSystemName) {
      return {
        ok: false,
        reason: `Unknown system variable: ${variable.name}`,
      };
    }

    if (variable.source !== 'system' && isSystemName) {
      return {
        ok: false,
        reason: `Reserved system variable name: ${variable.name}`,
      };
    }

    names.add(variable.name);
  }

  return { ok: true, names };
}

function splitPlaceholder(inner: string): { varName: string; inlineDefault: string | undefined } {
  const pipeIdx = inner.indexOf('|');
  if (pipeIdx === -1) {
    return { varName: inner, inlineDefault: undefined };
  }
  return {
    varName: inner.slice(0, pipeIdx),
    inlineDefault: inner.slice(pipeIdx + 1),
  };
}

/**
 * Validates declared variable metadata and scans the template body for syntax
 * and declaration errors with 1-based line and column coordinates.
 */
export function validateTemplate(
  body: string,
  declared: PromptVariable[],
): TemplateValidationResult {
  const declaredCheck = validateDeclaredVariables(declared);
  if (!declaredCheck.ok) {
    return { ok: false, line: 1, column: 1, reason: declaredCheck.reason };
  }

  const declaredNames = declaredCheck.names;
  let line = 1;
  let column = 1;
  let inPlaceholder = false;
  let openLine = 1;
  let openColumn = 1;
  let openContentStart = 0;

  for (let i = 0; i < body.length; ) {
    const ch = body[i];
    const next = body[i + 1];

    if (!inPlaceholder) {
      if (ch === '{' && next === '{') {
        inPlaceholder = true;
        openLine = line;
        openColumn = column;
        openContentStart = i + 2;
        i += 2;
        column += 2;
        continue;
      }

      if (ch === '}' && next === '}') {
        return {
          ok: false,
          line,
          column,
          reason: 'Unexpected closing "}}"',
        };
      }
    } else {
      if (ch === '{' && next === '{') {
        return {
          ok: false,
          line,
          column,
          reason: 'Nested "{{" inside placeholder',
        };
      }

      if (ch === '}' && next === '}') {
        const inner = body.slice(openContentStart, i);
        const { varName } = splitPlaceholder(inner);

        if (!PROMPT_VAR_NAME_REGEX.test(varName)) {
          return {
            ok: false,
            line: openLine,
            column: openColumn,
            reason: `Invalid variable syntax in placeholder: "${varName}"`,
          };
        }

        if (!SYSTEM_PROMPT_VARIABLE_NAMES.has(varName) && !declaredNames.has(varName)) {
          return {
            ok: false,
            line: openLine,
            column: openColumn,
            reason: `Undeclared variable: ${varName}`,
          };
        }

        inPlaceholder = false;
        i += 2;
        column += 2;
        continue;
      }
    }

    if (ch === '\r' && next === '\n') {
      i += 2;
      line += 1;
      column = 1;
    } else if (ch === '\n') {
      i += 1;
      line += 1;
      column = 1;
    } else {
      i += 1;
      column += 1;
    }
  }

  if (inPlaceholder) {
    return {
      ok: false,
      line: openLine,
      column: openColumn,
      reason: 'Unclosed "{{" placeholder',
    };
  }

  return { ok: true };
}

/**
 * Performs single-pass left-to-right placeholder substitution.
 * Returns the exact template string reference when no "{{" is present.
 */
export function renderWith(
  template: string,
  values: Record<string, string>,
  declared: PromptVariable[],
): RenderTemplateResult {
  if (!template.includes('{{')) {
    return { rendered: template, missing: [] };
  }

  const safeValues = values ?? {};
  const declaredByName = new Map<string, PromptVariable>();
  for (const variable of declared ?? []) {
    declaredByName.set(variable.name, variable);
  }

  const missing: string[] = [];
  const missingSet = new Set<string>();
  let rendered = '';
  let cursor = 0;

  while (cursor < template.length) {
    const start = template.indexOf('{{', cursor);
    if (start === -1) {
      rendered += template.slice(cursor);
      break;
    }

    const close = template.indexOf('}}', start + 2);
    if (close === -1) {
      rendered += template.slice(cursor);
      break;
    }

    const inner = template.slice(start + 2, close);
    const nested = inner.indexOf('{{');
    if (nested !== -1) {
      rendered += template.slice(cursor, start + 2 + nested);
      cursor = start + 2 + nested;
      continue;
    }

    const { varName, inlineDefault } = splitPlaceholder(inner);
    if (!PROMPT_VAR_NAME_REGEX.test(varName)) {
      rendered += template.slice(cursor, close + 2);
      cursor = close + 2;
      continue;
    }

    rendered += template.slice(cursor, start);

    const hasOwn = Object.prototype.hasOwnProperty.call(safeValues, varName);
    const rawValue = hasOwn ? safeValues[varName] : undefined;

    if (rawValue !== undefined && rawValue !== '') {
      rendered += sanitizeVariableValue(String(rawValue));
    } else if (inlineDefault !== undefined) {
      rendered += inlineDefault;
    } else {
      const declaredVar = declaredByName.get(varName);
      if (declaredVar !== undefined && declaredVar.default !== undefined) {
        rendered += declaredVar.default;
      } else {
        if (!missingSet.has(varName)) {
          missingSet.add(varName);
          missing.push(varName);
        }
      }
    }

    cursor = close + 2;
  }

  return { rendered, missing };
}
