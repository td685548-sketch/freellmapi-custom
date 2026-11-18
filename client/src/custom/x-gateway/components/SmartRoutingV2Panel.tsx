import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useUserSession } from '../../use-session'
import { useSessionRevision } from '../../session-state'
import {
  SCENARIO_LANE_ORDER,
  smartRoutingV2Api,
  useSmartRoutingV2Strings,
  type AgentScenarioLane,
  type IntentClassificationResult,
  type SmartRoutingDecisionMode,
} from '../smart-routing-v2-strings'

interface PolicyDraft {
  enabled?: boolean
  decisionMode?: SmartRoutingDecisionMode
  longContextThresholdTokens?: string
  lanes?: Partial<Record<AgentScenarioLane, string>>
}

const isValidThreshold = (raw: string): boolean => {
  if (!/^\d{4,7}$/.test(raw.trim())) return false
  const n = Number(raw.trim())
  return Number.isInteger(n) && n >= 1_000 && n <= 2_000_000
}

export function SmartRoutingV2Panel() {
  const s = useSmartRoutingV2Strings()
  const queryClient = useQueryClient()
  const revision = useSessionRevision()
  const canEdit = useUserSession().hasPermission('edit_x_settings')

  const policyQuery = useQuery({
    queryKey: ['x-smart-routing-policy', revision],
    queryFn: ({ signal }) => smartRoutingV2Api.getPolicy(signal),
    retry: false,
  })
  const capsQuery = useQuery({
    queryKey: ['x-smart-routing-caps', revision],
    queryFn: ({ signal }) => smartRoutingV2Api.getLearnedCaps(signal),
    retry: false,
  })
  const modelsDevQuery = useQuery({
    queryKey: ['x-smart-routing-models-dev', revision],
    queryFn: ({ signal }) => smartRoutingV2Api.getModelsDevStatus(signal),
    retry: false,
  })

  const [draft, setDraft] = useState<PolicyDraft>({})
  const [testPrompt, setTestPrompt] = useState('')
  const [testSystemPrompt, setTestSystemPrompt] = useState('')
  const [testHasVision, setTestHasVision] = useState(false)
  const [testHasWebSearch, setTestHasWebSearch] = useState(false)
  const [testThinkingEnabled, setTestThinkingEnabled] = useState(false)
  const [previewResult, setPreviewResult] = useState<IntentClassificationResult | null>(null)

  const currentPolicy = policyQuery.data
  const effectiveEnabled = draft.enabled ?? currentPolicy?.enabled ?? false
  const effectiveMode: SmartRoutingDecisionMode = draft.decisionMode ?? currentPolicy?.decisionMode ?? 'heuristic'
  const effectiveThreshold = draft.longContextThresholdTokens ?? String(currentPolicy?.longContextThresholdTokens ?? 60000)
  const thresholdOk = isValidThreshold(effectiveThreshold)

  const effectiveLanes: Record<AgentScenarioLane, string> = {
    default: draft.lanes?.default ?? currentPolicy?.lanes.default ?? '',
    background: draft.lanes?.background ?? currentPolicy?.lanes.background ?? '',
    think: draft.lanes?.think ?? currentPolicy?.lanes.think ?? '',
    longContext: draft.lanes?.longContext ?? currentPolicy?.lanes.longContext ?? '',
    webSearch: draft.lanes?.webSearch ?? currentPolicy?.lanes.webSearch ?? '',
    vision: draft.lanes?.vision ?? currentPolicy?.lanes.vision ?? '',
  }

  const laneLabel = (lane: AgentScenarioLane): string => {
    switch (lane) {
      case 'default':
        return s.laneDefault
      case 'background':
        return s.laneBackground
      case 'think':
        return s.laneThink
      case 'longContext':
        return s.laneLongContext
      case 'webSearch':
        return s.laneWebSearch
      case 'vision':
        return s.laneVision
    }
  }

  const dirty =
    draft.enabled !== undefined
    || draft.decisionMode !== undefined
    || draft.longContextThresholdTokens !== undefined
    || draft.lanes !== undefined

  const savePolicy = useMutation({
    meta: { silenceToast: true },
    mutationFn: () =>
      smartRoutingV2Api.savePolicy({
        enabled: effectiveEnabled,
        decisionMode: effectiveMode,
        longContextThresholdTokens: Number(effectiveThreshold.trim()),
        lanes: effectiveLanes,
      }),
    onSuccess: async () => {
      setDraft({})
      await queryClient.invalidateQueries({ queryKey: ['x-smart-routing-policy'] })
    },
  })

  const runPreview = useMutation({
    meta: { silenceToast: true },
    mutationFn: () =>
      smartRoutingV2Api.classifyPreview({
        prompt: testPrompt,
        ...(testSystemPrompt.trim() ? { systemPrompt: testSystemPrompt.trim() } : {}),
        hasVision: testHasVision,
        hasWebSearchTool: testHasWebSearch,
        thinkingEnabled: testThinkingEnabled,
      }),
    onSuccess: data => {
      setPreviewResult(data)
    },
  })

  const clearCaps = useMutation({
    meta: { silenceToast: true },
    mutationFn: (params?: { provider?: string; modelId?: string; endpointScope?: string }) =>
      smartRoutingV2Api.clearLearnedCaps(params),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['x-smart-routing-caps'] })
    },
  })

  const toggleModelsDevPeriodic = useMutation({
    meta: { silenceToast: true },
    mutationFn: (enabled: boolean) => smartRoutingV2Api.setModelsDevEnabled(enabled),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['x-smart-routing-models-dev'] })
    },
  })

  const triggerModelsDevSync = useMutation({
    meta: { silenceToast: true },
    mutationFn: (dryRun: boolean) => smartRoutingV2Api.syncModelsDev(dryRun),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['x-smart-routing-models-dev'] })
    },
  })

  const caps = capsQuery.data?.caps ?? []
  const mdStatus = modelsDevQuery.data
  const envKillSwitch = mdStatus?.envOverride === 'false'
  const envForcedOn = mdStatus?.envOverride === 'true'

  return (
    <section className="x-panel x-endpoint-panel" aria-labelledby="x-set-smart-routing-v2" data-testid="smart-routing-v2-panel">
      <h2 id="x-set-smart-routing-v2">{s.sectionTitle}</h2>
      <p className="x-caption">{s.sectionHelp}</p>

      {policyQuery.isError && (
        <div className="x-error" role="alert">
          {s.loadError}
          <button type="button" className="x-button" onClick={() => void policyQuery.refetch()}>
            {s.retry}
          </button>
        </div>
      )}
      {!canEdit && !policyQuery.isError && <p className="x-caption">{s.readOnly}</p>}

      {currentPolicy && (
        <form
          className="x-mgmt-form"
          onSubmit={e => {
            e.preventDefault()
            if (canEdit && thresholdOk) savePolicy.mutate()
          }}
        >
          <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <input
              type="checkbox"
              checked={effectiveEnabled}
              disabled={!canEdit}
              onChange={e => setDraft(d => ({ ...d, enabled: e.target.checked }))}
            />
            <span>
              <strong>{s.enablePolicy}</strong>
              <br />
              <small className="x-caption">{s.enablePolicyHelp}</small>
            </span>
          </label>

          <label>
            {s.decisionMode}
            <select
              aria-label={s.decisionMode}
              value={effectiveMode}
              disabled={!canEdit}
              onChange={e =>
                setDraft(d => ({
                  ...d,
                  decisionMode: e.target.value === 'llm' ? 'llm' : 'heuristic',
                }))
              }
            >
              <option value="heuristic">{s.modeHeuristic}</option>
              <option value="llm">{s.modeLlm}</option>
            </select>
          </label>

          <label>
            {s.longContextThreshold}
            <input
              inputMode="numeric"
              value={effectiveThreshold}
              disabled={!canEdit}
              aria-invalid={!thresholdOk}
              onChange={e => setDraft(d => ({ ...d, longContextThresholdTokens: e.target.value }))}
            />
            <small className="x-caption">{s.longContextThresholdHelp}</small>
          </label>

          {SCENARIO_LANE_ORDER.map(lane => (
            <label key={lane}>
              {laneLabel(lane)}
              <input
                data-testid={`lane-input-${lane}`}
                value={effectiveLanes[lane]}
                disabled={!canEdit}
                placeholder={s.lanePlaceholder}
                onChange={e =>
                  setDraft(d => ({
                    ...d,
                    lanes: {
                      ...(d.lanes ?? {}),
                      [lane]: e.target.value,
                    },
                  }))
                }
              />
            </label>
          ))}

          {canEdit && (
            <div>
              <button
                type="submit"
                className="x-button x-primary"
                disabled={!dirty || !thresholdOk || savePolicy.isPending}
              >
                {s.savePolicy}
              </button>
            </div>
          )}
          {savePolicy.isSuccess && !dirty && (
            <p className="x-test-ok" role="status">
              {s.policySaved}
            </p>
          )}
          {savePolicy.isError && (
            <p className="x-error" role="alert">
              {s.saveError}
            </p>
          )}
        </form>
      )}

      <hr style={{ margin: '20px 0', opacity: 0.2 }} />

      <div>
        <h3>{s.testerTitle}</h3>
        <p className="x-caption">{s.testerHelp}</p>
        <div className="x-mgmt-form">
          <label>
            {s.testerPromptLabel}
            <textarea
              rows={2}
              data-testid="smart-routing-tester-prompt"
              value={testPrompt}
              placeholder={s.testerPromptPlaceholder}
              onChange={e => setTestPrompt(e.target.value)}
            />
          </label>
          <label>
            {s.testerSystemLabel}
            <input
              value={testSystemPrompt}
              onChange={e => setTestSystemPrompt(e.target.value)}
            />
          </label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={testHasVision}
                onChange={e => setTestHasVision(e.target.checked)}
              />
              <span>{s.testerVisionFlag}</span>
            </label>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={testHasWebSearch}
                onChange={e => setTestHasWebSearch(e.target.checked)}
              />
              <span>{s.testerWebSearchFlag}</span>
            </label>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={testThinkingEnabled}
                onChange={e => setTestThinkingEnabled(e.target.checked)}
              />
              <span>{s.testerThinkingFlag}</span>
            </label>
          </div>
          <div>
            <button
              type="button"
              className="x-button"
              data-testid="smart-routing-tester-run"
              disabled={!testPrompt.trim() || runPreview.isPending}
              onClick={() => runPreview.mutate()}
            >
              {runPreview.isPending ? s.testerRunning : s.testerRun}
            </button>
          </div>

          {previewResult && (
            <div role="status" data-testid="smart-routing-preview-result" style={{ fontSize: 13 }}>
              <p>
                <strong>{s.resultIntent}:</strong> <code>{previewResult.intent}</code> |{' '}
                <strong>{s.resultScenario}:</strong> <code>{previewResult.scenario}</code> |{' '}
                <strong>{s.resultPreset}:</strong> <code>{previewResult.recommendedPreset}</code>
              </p>
              <p>
                <strong>{s.resultTarget}:</strong>{' '}
                <code>{previewResult.resolvedTarget ?? s.targetAutoFallback}</code> |{' '}
                <strong>{s.resultLatency}:</strong> <code>{previewResult.durationMs} ms</code>
              </p>
              {previewResult.signals.length > 0 && (
                <p>
                  <strong>{s.resultSignals}:</strong> <code>{previewResult.signals.join(', ')}</code>
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      <hr style={{ margin: '20px 0', opacity: 0.2 }} />

      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h3>{s.capsTitle}</h3>
            <p className="x-caption">{s.capsHelp}</p>
          </div>
          {canEdit && caps.length > 0 && (
            <button
              type="button"
              className="x-button"
              data-testid="learned-caps-clear-all"
              disabled={clearCaps.isPending}
              onClick={() => clearCaps.mutate(undefined)}
            >
              {s.capsClearAll}
            </button>
          )}
        </div>

        {caps.length === 0 ? (
          <p className="x-caption" data-testid="learned-caps-empty">{s.capsEmpty}</p>
        ) : (
          <table className="x-table" data-testid="learned-caps-table" style={{ width: '100%', marginTop: 8 }}>
            <thead>
              <tr>
                <th>{s.capsColModel}</th>
                <th>{s.capsColMaxOut}</th>
                <th>{s.capsColThinkBudget}</th>
                <th>{s.capsColEfforts}</th>
                <th>{s.capsColHits}</th>
                {canEdit && <th>{s.capsColActions}</th>}
              </tr>
            </thead>
            <tbody>
              {caps.map(item => {
                const rowKey = `${item.provider}::${item.modelId}::${item.endpointScope}`
                return (
                  <tr key={rowKey}>
                    <td>
                      <code>{item.provider}/{item.modelId}</code>
                      {item.endpointScope && (
                        <>
                          <br />
                          <small className="x-caption">{item.endpointScope}</small>
                        </>
                      )}
                    </td>
                    <td>{item.maxOutputTokens ?? '—'}</td>
                    <td>{item.maxThinkingBudget ?? '—'}</td>
                    <td>{item.supportedReasoningEfforts ? item.supportedReasoningEfforts.join(', ') : '—'}</td>
                    <td>{item.hitCount}</td>
                    {canEdit && (
                      <td>
                        <button
                          type="button"
                          className="x-button"
                          disabled={clearCaps.isPending}
                          onClick={() =>
                            clearCaps.mutate({
                              provider: item.provider,
                              modelId: item.modelId,
                              endpointScope: item.endpointScope,
                            })
                          }
                        >
                          {s.capsDeleteRow}
                        </button>
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      <hr style={{ margin: '20px 0', opacity: 0.2 }} />

      <div>
        <h3>{s.modelsDevTitle}</h3>
        <p className="x-caption">{s.modelsDevHelp}</p>

        {envKillSwitch && (
          <p className="x-error" role="status">
            {s.modelsDevEnvKillSwitch}
          </p>
        )}
        {envForcedOn && (
          <p className="x-caption" role="status">
            {s.modelsDevEnvForcedOn}
          </p>
        )}

        {mdStatus && (
          <div className="x-mgmt-form">
            <label style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={mdStatus.enabled}
                disabled={!canEdit || envKillSwitch || envForcedOn || toggleModelsDevPeriodic.isPending}
                onChange={e => toggleModelsDevPeriodic.mutate(e.target.checked)}
              />
              <span>{s.modelsDevEnablePeriodic}</span>
            </label>

            <p className="x-caption" data-testid="models-dev-status-summary">
              <strong>{s.modelsDevStoredModels}:</strong> {mdStatus.storedModelCount} |{' '}
              <strong>{s.modelsDevLastSync}:</strong> {mdStatus.lastSyncAt ?? s.modelsDevNever}
            </p>

            {canEdit && (
              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  type="button"
                  className="x-button x-primary"
                  data-testid="models-dev-sync-now"
                  disabled={envKillSwitch || triggerModelsDevSync.isPending}
                  onClick={() => triggerModelsDevSync.mutate(false)}
                >
                  {triggerModelsDevSync.isPending ? s.modelsDevSyncing : s.modelsDevSyncNow}
                </button>
                <button
                  type="button"
                  className="x-button"
                  data-testid="models-dev-dry-run"
                  disabled={envKillSwitch || triggerModelsDevSync.isPending}
                  onClick={() => triggerModelsDevSync.mutate(true)}
                >
                  {s.modelsDevDryRun}
                </button>
              </div>
            )}

            {triggerModelsDevSync.data?.success && (
              <p className="x-test-ok" role="status">
                {triggerModelsDevSync.data.dryRun ? s.modelsDevDryRunSuccess : s.modelsDevSyncSuccess}{' '}
                {triggerModelsDevSync.data.modelCount} {s.modelsDevModelsLabel}{' '}
                {triggerModelsDevSync.data.providerCount} {s.modelsDevProvidersLabel}
              </p>
            )}
            {triggerModelsDevSync.data && !triggerModelsDevSync.data.success && triggerModelsDevSync.data.error && (
              <p className="x-error" role="alert">
                {triggerModelsDevSync.data.error}
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
