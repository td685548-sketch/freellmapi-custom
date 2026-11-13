import crypto from 'node:crypto';
import {
  RESERVED_INTAKE_FIELD_KEYS,
  SUPPORT_DESK_INTAKE_FIELD_TYPES,
  SUPPORT_DESK_LIMITS,
  SUPPORT_DESK_WIDGET_POSITIONS,
  type SupportDeskIntakeField,
  type SupportDeskIntakeFieldType,
  type SupportDeskPublicWidgetConfig,
  type SupportDeskWidgetAppearance,
  type SupportDeskWidgetConfig,
  type SupportDeskWidgetPosition,
} from '@freellmapi/shared/support-service-desk.js';

export class SupportDeskError extends Error {
  public statusCode: number;

  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryAfterSeconds?: number,
    public fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'SupportDeskError';
    this.statusCode = status;
  }
}

const RESERVED_KEYS_NORMALIZED = new Set<string>(
  RESERVED_INTAKE_FIELD_KEYS.flatMap((k) => [k.toLowerCase(), k.toLowerCase().replace(/_/g, '')]),
);

const FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const UNSAFE_TEXT_RE = /[<>]|https?:\/\/|javascript:|data:|vbscript:|url\s*\(|expression\s*\(/i;

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if ((code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) {
      return true;
    }
  }
  return false;
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return false;
  const proto = Object.getPrototypeOf(val);
  return proto === Object.prototype || proto === null;
}

function assertAllowedKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.getOwnPropertyNames(obj)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype' || !allowed.includes(key)) {
      throw new SupportDeskError(400, 'invalid_input', `Unsupported field "${key}" in ${label}.`);
    }
  }
}

function assertSafeText(
  raw: unknown,
  label: string,
  minLen: number,
  maxLen: number,
): string {
  if (typeof raw !== 'string') {
    throw new SupportDeskError(400, 'invalid_input', `${label} must be a string.`);
  }
  const normalized = raw.trim().normalize('NFC');
  if (normalized.length < minLen || normalized.length > maxLen) {
    throw new SupportDeskError(
      400,
      'invalid_input',
      `${label} must be between ${minLen} and ${maxLen} characters.`,
    );
  }
  if (hasControlChars(normalized) || UNSAFE_TEXT_RE.test(normalized)) {
    throw new SupportDeskError(400, 'invalid_input', `${label} contains disallowed markup or URLs.`);
  }
  return normalized;
}

function validateAppearance(raw: unknown): SupportDeskWidgetAppearance {
  if (!isPlainObject(raw)) {
    throw new SupportDeskError(400, 'invalid_input', 'appearance must be a plain object.');
  }
  const requiredKeys = ['primaryColor', 'title', 'welcomeMessage', 'position', 'quickPrompts'] as const;
  assertAllowedKeys(raw, requiredKeys, 'appearance');
  for (const key of requiredKeys) {
    if (!(key in raw)) {
      throw new SupportDeskError(400, 'invalid_input', `appearance.${key} is required.`);
    }
  }

  if (typeof raw.primaryColor !== 'string' || !HEX_COLOR_RE.test(raw.primaryColor)) {
    throw new SupportDeskError(400, 'invalid_input', 'appearance.primaryColor must be a #RRGGBB hex color.');
  }
  const title = assertSafeText(raw.title, 'appearance.title', 1, SUPPORT_DESK_LIMITS.maxLabelChars);
  const welcomeMessage = assertSafeText(
    raw.welcomeMessage,
    'appearance.welcomeMessage',
    0,
    SUPPORT_DESK_LIMITS.maxTextChars,
  );
  if (
    typeof raw.position !== 'string' ||
    !(SUPPORT_DESK_WIDGET_POSITIONS as readonly string[]).includes(raw.position)
  ) {
    throw new SupportDeskError(400, 'invalid_input', 'appearance.position must be bottom-right or bottom-left.');
  }
  if (!Array.isArray(raw.quickPrompts) || raw.quickPrompts.length > SUPPORT_DESK_LIMITS.maxQuickPrompts) {
    throw new SupportDeskError(
      400,
      'invalid_input',
      `appearance.quickPrompts must be an array of at most ${SUPPORT_DESK_LIMITS.maxQuickPrompts} items.`,
    );
  }

  const quickPrompts: string[] = [];
  const seenPrompts = new Set<string>();
  for (let i = 0; i < raw.quickPrompts.length; i += 1) {
    const item = assertSafeText(
      raw.quickPrompts[i],
      `appearance.quickPrompts[${i}]`,
      1,
      SUPPORT_DESK_LIMITS.maxTextChars,
    );
    if (seenPrompts.has(item)) {
      throw new SupportDeskError(400, 'invalid_input', 'appearance.quickPrompts must be unique.');
    }
    seenPrompts.add(item);
    quickPrompts.push(item);
  }

  return {
    primaryColor: raw.primaryColor,
    title,
    welcomeMessage,
    position: raw.position as SupportDeskWidgetPosition,
    quickPrompts,
  };
}

function isReservedFieldKey(key: string): boolean {
  const lower = key.toLowerCase();
  return RESERVED_KEYS_NORMALIZED.has(lower) || RESERVED_KEYS_NORMALIZED.has(lower.replace(/_/g, ''));
}

function validateIntakeField(raw: unknown, index: number): SupportDeskIntakeField {
  if (!isPlainObject(raw)) {
    throw new SupportDeskError(400, 'invalid_input', `intake.fields[${index}] must be an object.`);
  }
  assertAllowedKeys(raw, ['key', 'label', 'type', 'required', 'options'], `intake.fields[${index}]`);

  if (typeof raw.key !== 'string' || !FIELD_KEY_RE.test(raw.key) || isReservedFieldKey(raw.key)) {
    throw new SupportDeskError(400, 'invalid_input', `intake.fields[${index}].key is invalid or reserved.`);
  }
  const label = assertSafeText(
    raw.label,
    `intake.fields[${index}].label`,
    1,
    SUPPORT_DESK_LIMITS.maxLabelChars,
  );
  if (
    typeof raw.type !== 'string' ||
    !(SUPPORT_DESK_INTAKE_FIELD_TYPES as readonly string[]).includes(raw.type)
  ) {
    throw new SupportDeskError(400, 'invalid_input', `intake.fields[${index}].type is invalid.`);
  }
  const type = raw.type as SupportDeskIntakeFieldType;
  if (typeof raw.required !== 'boolean') {
    throw new SupportDeskError(400, 'invalid_input', `intake.fields[${index}].required must be a boolean.`);
  }

  let options: string[] | undefined;
  if (type === 'select') {
    if (
      !Array.isArray(raw.options) ||
      raw.options.length < 1 ||
      raw.options.length > SUPPORT_DESK_LIMITS.maxOptions
    ) {
      throw new SupportDeskError(
        400,
        'invalid_input',
        `intake.fields[${index}].options must contain 1..${SUPPORT_DESK_LIMITS.maxOptions} items.`,
      );
    }
    options = [];
    const seen = new Set<string>();
    for (let j = 0; j < raw.options.length; j += 1) {
      const opt = assertSafeText(
        raw.options[j],
        `intake.fields[${index}].options[${j}]`,
        1,
        SUPPORT_DESK_LIMITS.maxLabelChars,
      );
      if (seen.has(opt)) {
        throw new SupportDeskError(400, 'invalid_input', `intake.fields[${index}].options must be unique.`);
      }
      seen.add(opt);
      options.push(opt);
    }
  } else if (raw.options !== undefined) {
    throw new SupportDeskError(
      400,
      'invalid_input',
      `intake.fields[${index}].options is only allowed for select fields.`,
    );
  }

  return {
    key: raw.key,
    label,
    type,
    required: raw.required,
    ...(options ? { options } : {}),
  };
}

function validateIntakeConfig(raw: unknown): SupportDeskWidgetConfig['intake'] {
  if (!isPlainObject(raw)) {
    throw new SupportDeskError(400, 'invalid_input', 'intake must be a plain object.');
  }
  assertAllowedKeys(raw, ['required', 'fields'], 'intake');
  if (typeof raw.required !== 'boolean') {
    throw new SupportDeskError(400, 'invalid_input', 'intake.required must be a boolean.');
  }
  if (!Array.isArray(raw.fields) || raw.fields.length > SUPPORT_DESK_LIMITS.maxFields) {
    throw new SupportDeskError(
      400,
      'invalid_input',
      `intake.fields must be an array of at most ${SUPPORT_DESK_LIMITS.maxFields} fields.`,
    );
  }

  const fields: SupportDeskIntakeField[] = [];
  const seenKeys = new Set<string>();
  for (let i = 0; i < raw.fields.length; i += 1) {
    const field = validateIntakeField(raw.fields[i], i);
    if (seenKeys.has(field.key)) {
      throw new SupportDeskError(400, 'invalid_input', `Duplicate intake field key "${field.key}".`);
    }
    seenKeys.add(field.key);
    fields.push(field);
  }

  return {
    required: raw.required,
    fields,
  };
}

export function validateWidgetConfigPatch(
  current: SupportDeskWidgetConfig,
  patch: unknown,
  updatedAt: string,
): SupportDeskWidgetConfig {
  if (!isPlainObject(patch)) {
    throw new SupportDeskError(400, 'invalid_input', 'Widget config patch must be a plain object.');
  }
  assertAllowedKeys(patch, ['enabled', 'appearance', 'intake'], 'widgetConfig');

  let enabled = current.enabled;
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') {
      throw new SupportDeskError(400, 'invalid_input', 'enabled must be a boolean.');
    }
    enabled = patch.enabled;
  }

  const appearance =
    patch.appearance !== undefined
      ? validateAppearance(patch.appearance)
      : {
          ...current.appearance,
          quickPrompts: [...current.appearance.quickPrompts],
        };

  const intake =
    patch.intake !== undefined
      ? validateIntakeConfig(patch.intake)
      : {
          required: current.intake.required,
          fields: current.intake.fields.map((f) => ({
            ...f,
            ...(f.options ? { options: [...f.options] } : {}),
          })),
        };

  if (intake.required) {
    if (!enabled) {
      throw new SupportDeskError(400, 'invalid_input', 'intake.required=true requires enabled=true.');
    }
    if (!intake.fields.some((f) => f.required)) {
      throw new SupportDeskError(
        400,
        'invalid_input',
        'intake.required=true requires at least one required intake field.',
      );
    }
  }

  return {
    version: current.version + 1,
    updatedAt,
    enabled,
    appearance,
    intake,
  };
}

export function computeSupportDeskIntakeSchemaHash(
  config: Pick<SupportDeskWidgetConfig, 'intake'>,
): string {
  const canonical = {
    required: Boolean(config.intake.required),
    fields: config.intake.fields.map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      required: Boolean(f.required),
      ...(f.type === 'select' ? { options: [...(f.options ?? [])] } : {}),
    })),
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function projectSupportDeskWidgetConfig(
  config: SupportDeskWidgetConfig,
): SupportDeskPublicWidgetConfig {
  return {
    version: config.version,
    enabled: config.enabled,
    appearance: {
      primaryColor: config.appearance.primaryColor,
      title: config.appearance.title,
      welcomeMessage: config.appearance.welcomeMessage,
      position: config.appearance.position,
      quickPrompts: [...config.appearance.quickPrompts],
    },
    intake: {
      required: config.intake.required,
      fields: config.intake.fields.map((f) => ({
        ...f,
        ...(f.options ? { options: [...f.options] } : {}),
      })),
      schemaHash: computeSupportDeskIntakeSchemaHash(config),
    },
  };
}

export function validateSupportDeskIntake(
  config: SupportDeskWidgetConfig,
  values: unknown,
): Record<string, string | number> {
  if (!isPlainObject(values)) {
    throw new SupportDeskError(400, 'invalid_intake', 'Intake values must be a plain object.', undefined, {
      _form: 'invalid_type',
    });
  }

  const serialized = JSON.stringify(values);
  if (Buffer.byteLength(serialized, 'utf8') > SUPPORT_DESK_LIMITS.maxIntakeBytes) {
    throw new SupportDeskError(400, 'invalid_intake', 'Intake payload exceeds maximum size.', undefined, {
      _form: 'payload_too_large',
    });
  }

  const fieldErrors: Record<string, string> = {};
  const configuredByKey = new Map<string, SupportDeskIntakeField>();
  for (const field of config.intake.fields) {
    configuredByKey.set(field.key, field);
  }

  for (const key of Object.getOwnPropertyNames(values)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype' || isReservedFieldKey(key)) {
      fieldErrors[key] = 'reserved_field';
      continue;
    }
    if (!configuredByKey.has(key)) {
      fieldErrors[key] = 'unknown_field';
    }
  }

  const validated: Record<string, string | number> = {};

  for (const field of config.intake.fields) {
    const hasOwn = Object.prototype.hasOwnProperty.call(values, field.key);
    const raw = hasOwn ? values[field.key] : undefined;

    if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
      if (field.required) {
        fieldErrors[field.key] = 'required';
      }
      continue;
    }

    switch (field.type) {
      case 'text': {
        if (typeof raw !== 'string') {
          fieldErrors[field.key] = 'invalid_type';
          break;
        }
        const normalized = raw.trim().normalize('NFC');
        if (hasControlChars(normalized)) {
          fieldErrors[field.key] = 'invalid_characters';
          break;
        }
        if (normalized.length > SUPPORT_DESK_LIMITS.maxValueChars) {
          fieldErrors[field.key] = 'too_long';
          break;
        }
        validated[field.key] = normalized;
        break;
      }
      case 'email': {
        if (typeof raw !== 'string') {
          fieldErrors[field.key] = 'invalid_type';
          break;
        }
        const normalized = raw.trim().normalize('NFC');
        if (
          normalized.length > 254 ||
          hasControlChars(normalized) ||
          !EMAIL_RE.test(normalized)
        ) {
          fieldErrors[field.key] = 'invalid_email';
          break;
        }
        validated[field.key] = normalized;
        break;
      }
      case 'number': {
        if (typeof raw !== 'number' || !Number.isFinite(raw)) {
          fieldErrors[field.key] = 'invalid_type';
          break;
        }
        if (raw < -1e9 || raw > 1e9) {
          fieldErrors[field.key] = 'out_of_range';
          break;
        }
        validated[field.key] = raw;
        break;
      }
      case 'select': {
        if (typeof raw !== 'string') {
          fieldErrors[field.key] = 'invalid_type';
          break;
        }
        if (!field.options || !field.options.includes(raw)) {
          fieldErrors[field.key] = 'invalid_option';
          break;
        }
        validated[field.key] = raw;
        break;
      }
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw new SupportDeskError(400, 'invalid_intake', 'Invalid intake values.', undefined, fieldErrors);
  }

  return validated;
}
