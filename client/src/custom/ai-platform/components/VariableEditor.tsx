import { useMemo, useState } from 'react';
import { useCustomT } from '../../i18n/use-custom-t';
import {
  PROMPT_LIMITS,
  PROMPT_VAR_NAME_REGEX,
  SYSTEM_PROMPT_VARIABLES,
  SYSTEM_PROMPT_VARIABLE_NAMES,
  detectDynamicVariablesInBody,
  type PromptVariable,
  type PromptVariableSource,
  type SystemPromptVariableDescriptor,
} from '../prompts-api';
import {
  PROMPTS_CACHE_PREFIX_WARNING_BODY,
  PROMPTS_CACHE_PREFIX_WARNING_TITLE,
  PROMPTS_DECLARED_VARS_EMPTY,
  PROMPTS_DECLARED_VARS_HEADING,
  PROMPTS_SYS_VARS_HEADING,
  PROMPTS_SYS_VAR_DESC_COL,
  PROMPTS_SYS_VAR_DYNAMIC,
  PROMPTS_SYS_VAR_EXAMPLE_COL,
  PROMPTS_SYS_VAR_NAME_COL,
  PROMPTS_SYS_VAR_STATIC,
  PROMPTS_SYS_VAR_TYPE_COL,
  PROMPTS_VARS_HEADING,
  PROMPTS_VARS_SUBTITLE,
  PROMPTS_VAR_ADD_BTN,
  PROMPTS_VAR_DEFAULT_LABEL,
  PROMPTS_VAR_DEFAULT_PLACEHOLDER,
  PROMPTS_VAR_DESC_LABEL,
  PROMPTS_VAR_DESC_PLACEHOLDER,
  PROMPTS_VAR_ERR_DUPLICATE,
  PROMPTS_VAR_ERR_REGEX,
  PROMPTS_VAR_ERR_SYSTEM,
  PROMPTS_VAR_NAME_LABEL,
  PROMPTS_VAR_NAME_PLACEHOLDER,
  PROMPTS_VAR_REMOVE_BTN,
  PROMPTS_VAR_SOURCE_CALLER,
  PROMPTS_VAR_SOURCE_CUSTOM,
  PROMPTS_VAR_SOURCE_LABEL,
} from '../prompts-strings';

export interface VariableEditorProps {
  body: string;
  variables: PromptVariable[];
  systemVariables?: readonly SystemPromptVariableDescriptor[];
  canEdit: boolean;
  onChange: (next: PromptVariable[]) => void;
}

export function VariableEditor({
  body,
  variables,
  systemVariables = SYSTEM_PROMPT_VARIABLES,
  canEdit,
  onChange,
}: VariableEditorProps) {
  const tc = useCustomT();

  const [newName, setNewName] = useState('');
  const [newSource, setNewSource] = useState<'caller' | 'custom'>('caller');
  const [newDefault, setNewDefault] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const dynamicVarsInBody = useMemo(
    () => detectDynamicVariablesInBody(body, variables, systemVariables),
    [body, variables, systemVariables],
  );

  function handleAddVariable() {
    if (!canEdit) return;
    const trimmedName = newName.trim();
    if (!PROMPT_VAR_NAME_REGEX.test(trimmedName)) {
      setFormError(tc(PROMPTS_VAR_ERR_REGEX));
      return;
    }
    if (SYSTEM_PROMPT_VARIABLE_NAMES.has(trimmedName)) {
      setFormError(tc(PROMPTS_VAR_ERR_SYSTEM, { name: trimmedName }));
      return;
    }
    if (variables.some((v) => v.name === trimmedName)) {
      setFormError(tc(PROMPTS_VAR_ERR_DUPLICATE, { name: trimmedName }));
      return;
    }

    const entry: PromptVariable = {
      name: trimmedName,
      source: newSource,
      ...(newDefault !== '' ? { default: newDefault } : {}),
      ...(newDesc.trim() !== '' ? { description: newDesc.trim() } : {}),
    };
    onChange([...variables, entry]);
    setNewName('');
    setNewDefault('');
    setNewDesc('');
    setFormError(null);
  }

  function handleUpdateVariable(index: number, patch: Partial<PromptVariable>) {
    if (!canEdit) return;
    const next = variables.map((v, idx) => (idx === index ? { ...v, ...patch } : v));
    onChange(next);
  }

  function handleRemoveVariable(index: number) {
    if (!canEdit) return;
    onChange(variables.filter((_, idx) => idx !== index));
  }

  return (
    <div className="space-y-4" data-testid="prompt-variable-editor">
      <div>
        <h3 className="text-sm font-semibold">{tc(PROMPTS_VARS_HEADING)}</h3>
        <p className="text-xs text-muted-foreground">{tc(PROMPTS_VARS_SUBTITLE)}</p>
      </div>

      {/* Cache-prefix stability warning (T113) */}
      {dynamicVarsInBody.length > 0 && (
        <div
          role="alert"
          data-testid="prompt-cache-prefix-warning"
          className="rounded-md border border-amber-600/30 bg-amber-600/15 dark:bg-amber-400/15 px-3 py-2 text-xs text-amber-700 dark:text-amber-400 space-y-0.5"
        >
          <div className="font-semibold">{tc(PROMPTS_CACHE_PREFIX_WARNING_TITLE)}</div>
          <div>
            {tc(PROMPTS_CACHE_PREFIX_WARNING_BODY, {
              vars: dynamicVarsInBody.map((v) => `{{${v}}}`).join(', '),
            })}
          </div>
        </div>
      )}

      {/* Read-only Built-in System Variables */}
      <div className="space-y-2">
        <div className="text-xs font-medium text-muted-foreground">{tc(PROMPTS_SYS_VARS_HEADING)}</div>
        <div className="overflow-x-auto rounded border">
          <table className="w-full text-xs" data-testid="prompt-system-variables">
            <thead className="bg-muted/40 text-left">
              <tr>
                <th className="px-2.5 py-1.5 font-medium">{tc(PROMPTS_SYS_VAR_NAME_COL)}</th>
                <th className="px-2.5 py-1.5 font-medium">{tc(PROMPTS_SYS_VAR_TYPE_COL)}</th>
                <th className="px-2.5 py-1.5 font-medium">{tc(PROMPTS_SYS_VAR_DESC_COL)}</th>
                <th className="px-2.5 py-1.5 font-medium">{tc(PROMPTS_SYS_VAR_EXAMPLE_COL)}</th>
              </tr>
            </thead>
            <tbody>
              {systemVariables.map((sv) => (
                <tr key={sv.name} className="border-t">
                  <td className="px-2.5 py-1.5 font-mono">{`{{${sv.name}}}`}</td>
                  <td className="px-2.5 py-1.5">
                    <span
                      className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${
                        sv.dynamicPerRequest
                          ? 'bg-amber-600/15 dark:bg-amber-400/15 text-amber-700 dark:text-amber-400'
                          : 'bg-emerald-600/15 dark:bg-emerald-400/15 text-emerald-700 dark:text-emerald-400'
                      }`}
                    >
                      {sv.dynamicPerRequest ? tc(PROMPTS_SYS_VAR_DYNAMIC) : tc(PROMPTS_SYS_VAR_STATIC)}
                    </span>
                  </td>
                  <td className="px-2.5 py-1.5 text-muted-foreground">{sv.description}</td>
                  <td className="px-2.5 py-1.5 font-mono text-muted-foreground">{sv.example}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Declared caller & custom variables */}
      <div className="space-y-2">
        <div className="text-xs font-medium text-muted-foreground">{tc(PROMPTS_DECLARED_VARS_HEADING)}</div>

        {variables.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="prompt-declared-vars-empty">
            {tc(PROMPTS_DECLARED_VARS_EMPTY)}
          </p>
        ) : (
          <div className="space-y-2" data-testid="prompt-declared-variables">
            {variables.map((v, idx) => (
              <div
                key={v.name}
                data-testid={`prompt-declared-var-${v.name}`}
                className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-end rounded border p-2.5 bg-muted/10"
              >
                <div className="sm:col-span-3">
                  <div className="text-[11px] text-muted-foreground">{tc(PROMPTS_VAR_NAME_LABEL)}</div>
                  <div className="font-mono text-xs font-medium py-1">{`{{${v.name}}}`}</div>
                </div>

                <label className="sm:col-span-3 space-y-1 text-[11px]">
                  <span className="text-muted-foreground">{tc(PROMPTS_VAR_SOURCE_LABEL)}</span>
                  <select
                    className="block w-full rounded border px-2 py-1 text-xs bg-background"
                    data-testid={`prompt-var-source-${v.name}`}
                    disabled={!canEdit}
                    value={v.source}
                    onChange={(e) =>
                      handleUpdateVariable(idx, { source: e.target.value as PromptVariableSource })
                    }
                  >
                    <option value="caller">{tc(PROMPTS_VAR_SOURCE_CALLER)}</option>
                    <option value="custom">{tc(PROMPTS_VAR_SOURCE_CUSTOM)}</option>
                  </select>
                </label>

                <label className="sm:col-span-3 space-y-1 text-[11px]">
                  <span className="text-muted-foreground">{tc(PROMPTS_VAR_DEFAULT_LABEL)}</span>
                  <input
                    type="text"
                    className="block w-full rounded border px-2 py-1 text-xs bg-background"
                    data-testid={`prompt-var-default-${v.name}`}
                    disabled={!canEdit}
                    maxLength={PROMPT_LIMITS.maxCallerVarValueChars}
                    placeholder={tc(PROMPTS_VAR_DEFAULT_PLACEHOLDER)}
                    value={v.default ?? ''}
                    onChange={(e) => handleUpdateVariable(idx, { default: e.target.value })}
                  />
                </label>

                <label className="sm:col-span-2 space-y-1 text-[11px]">
                  <span className="text-muted-foreground">{tc(PROMPTS_VAR_DESC_LABEL)}</span>
                  <input
                    type="text"
                    className="block w-full rounded border px-2 py-1 text-xs bg-background"
                    data-testid={`prompt-var-desc-${v.name}`}
                    disabled={!canEdit}
                    placeholder={tc(PROMPTS_VAR_DESC_PLACEHOLDER)}
                    value={v.description ?? ''}
                    onChange={(e) => handleUpdateVariable(idx, { description: e.target.value })}
                  />
                </label>

                <div className="sm:col-span-1 flex justify-end">
                  <button
                    type="button"
                    data-testid={`prompt-var-remove-${v.name}`}
                    disabled={!canEdit}
                    onClick={() => handleRemoveVariable(idx)}
                    className="rounded border px-2 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
                  >
                    {tc(PROMPTS_VAR_REMOVE_BTN)}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Add new variable form */}
        <div
          className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-end rounded border border-dashed p-2.5"
          data-testid="prompt-add-variable-form"
        >
          <label className="sm:col-span-3 space-y-1 text-[11px]">
            <span className="font-medium">{tc(PROMPTS_VAR_NAME_LABEL)}</span>
            <input
              type="text"
              data-testid="prompt-var-name-input"
              aria-label={tc(PROMPTS_VAR_NAME_LABEL)}
              disabled={!canEdit}
              maxLength={PROMPT_LIMITS.maxVarNameChars}
              placeholder={tc(PROMPTS_VAR_NAME_PLACEHOLDER)}
              className="block w-full rounded border px-2 py-1 text-xs font-mono bg-background"
              value={newName}
              onChange={(e) => {
                setNewName(e.target.value);
                if (formError) setFormError(null);
              }}
            />
          </label>

          <label className="sm:col-span-3 space-y-1 text-[11px]">
            <span className="font-medium">{tc(PROMPTS_VAR_SOURCE_LABEL)}</span>
            <select
              data-testid="prompt-var-source-select"
              aria-label={tc(PROMPTS_VAR_SOURCE_LABEL)}
              disabled={!canEdit}
              className="block w-full rounded border px-2 py-1 text-xs bg-background"
              value={newSource}
              onChange={(e) => setNewSource(e.target.value as 'caller' | 'custom')}
            >
              <option value="caller">{tc(PROMPTS_VAR_SOURCE_CALLER)}</option>
              <option value="custom">{tc(PROMPTS_VAR_SOURCE_CUSTOM)}</option>
            </select>
          </label>

          <label className="sm:col-span-2 space-y-1 text-[11px]">
            <span className="font-medium">{tc(PROMPTS_VAR_DEFAULT_LABEL)}</span>
            <input
              type="text"
              data-testid="prompt-var-default-input"
              aria-label={tc(PROMPTS_VAR_DEFAULT_LABEL)}
              disabled={!canEdit}
              maxLength={PROMPT_LIMITS.maxCallerVarValueChars}
              placeholder={tc(PROMPTS_VAR_DEFAULT_PLACEHOLDER)}
              className="block w-full rounded border px-2 py-1 text-xs bg-background"
              value={newDefault}
              onChange={(e) => setNewDefault(e.target.value)}
            />
          </label>

          <label className="sm:col-span-2 space-y-1 text-[11px]">
            <span className="font-medium">{tc(PROMPTS_VAR_DESC_LABEL)}</span>
            <input
              type="text"
              data-testid="prompt-var-desc-input"
              aria-label={tc(PROMPTS_VAR_DESC_LABEL)}
              disabled={!canEdit}
              placeholder={tc(PROMPTS_VAR_DESC_PLACEHOLDER)}
              className="block w-full rounded border px-2 py-1 text-xs bg-background"
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
            />
          </label>

          <div className="sm:col-span-2 flex justify-end">
            <button
              type="button"
              data-testid="prompt-var-add-btn"
              disabled={!canEdit}
              onClick={handleAddVariable}
              className="w-full rounded bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {tc(PROMPTS_VAR_ADD_BTN)}
            </button>
          </div>
        </div>

        {formError && (
          <p className="text-xs text-destructive" role="alert" data-testid="prompt-var-error">
            {formError}
          </p>
        )}
      </div>
    </div>
  );
}
