export const COMBO_NAME_RE = /^[a-z0-9\-_.]{1,48}$/;
export const RESERVED_PREFIXES = ['auto:', 'combo:'];
export const RESERVED_NAMES = new Set(['auto']);
export const MAX_COMBOS = 50;
export const MAX_ENTRIES = 20;

export interface ComboEntry {
  platform: string;
  modelId: string;
}

export interface ComboValidationError {
  error: string;
}

export function validateComboName(name: string): ComboValidationError | null {
  const lower = name.toLowerCase();
  if (!COMBO_NAME_RE.test(lower)) {
    return { error: 'Combo name must be 1-48 characters of a-z, 0-9, -, _, .' };
  }
  if (RESERVED_NAMES.has(lower)) {
    return { error: 'Combo name cannot be a reserved word' };
  }
  for (const prefix of RESERVED_PREFIXES) {
    if (lower.startsWith(prefix)) {
      return { error: `Combo name cannot start with "${prefix}"` };
    }
  }
  return null;
}

export function validateComboEntries(entries: unknown): entries is ComboEntry[] {
  if (!Array.isArray(entries)) return false;
  if (entries.length < 1 || entries.length > MAX_ENTRIES) return false;
  const seen = new Set<string>();
  for (const e of entries) {
    if (!e || typeof e !== 'object') return false;
    const entry = e as Record<string, unknown>;
    if (typeof entry.platform !== 'string' || !entry.platform.trim()) return false;
    if (typeof entry.modelId !== 'string' || !entry.modelId.trim()) return false;
    const key = `${entry.platform}:${entry.modelId}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

export interface ValidateComboOptions {
  existingModelIds?: Iterable<string>;
  totalCombos?: number;
}

export function validateCombo(
  name: string,
  entries: unknown,
  opts?: ValidateComboOptions,
): { valid: true } | { valid: false; error: string } {
  if (typeof name !== 'string') {
    return { valid: false, error: 'Combo name must be a string' };
  }
  const lower = name.toLowerCase();
  const nameError = validateComboName(lower);
  if (nameError) {
    return { valid: false, error: nameError.error };
  }

  if (opts?.existingModelIds) {
    const ids = new Set(Array.from(opts.existingModelIds).map(id => id.toLowerCase()));
    if (ids.has(lower)) {
      return { valid: false, error: `Combo name cannot equal an existing model id: ${lower}` };
    }
  }

  if (opts?.totalCombos !== undefined && opts.totalCombos >= MAX_COMBOS) {
    return { valid: false, error: `Maximum limit of ${MAX_COMBOS} combos reached` };
  }

  if (!validateComboEntries(entries)) {
    if (!Array.isArray(entries)) {
      return { valid: false, error: 'Entries must be an array' };
    }
    if (entries.length < 1 || entries.length > MAX_ENTRIES) {
      return { valid: false, error: `Entries count must be between 1 and ${MAX_ENTRIES}` };
    }
    const seen = new Set<string>();
    for (const e of entries) {
      if (!e || typeof e !== 'object') {
        return { valid: false, error: 'Each entry must be an object with platform and modelId' };
      }
      const entry = e as Record<string, unknown>;
      if (typeof entry.platform !== 'string' || !entry.platform.trim() || typeof entry.modelId !== 'string' || !entry.modelId.trim()) {
        return { valid: false, error: 'Each entry must have non-empty platform and modelId strings' };
      }
      const key = `${entry.platform}:${entry.modelId}`;
      if (seen.has(key)) {
        return { valid: false, error: `Duplicate entry found: ${key}` };
      }
      seen.add(key);
    }
    return { valid: false, error: 'Invalid combo entries' };
  }

  return { valid: true };
}
