import { useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Activity, AlertTriangle, CircleCheck, Gauge, RotateCcw, Scale } from 'lucide-react'
import {
  DEFAULT_CREDENTIAL_WEIGHT,
  MAX_ACCOUNT_CONCURRENCY,
  MAX_CREDENTIAL_WEIGHT,
  MIN_CREDENTIAL_WEIGHT,
  type AccountResiliencePolicy,
  type AccountSemaphoreSnapshot,
} from '../../../../../shared/account-resilience'
import {
  resetAccountRefreshCircuit,
  updateAccountResilience,
  useAccountResilienceStrings,
} from '../account-resilience-strings'

interface AccountResilienceControlsProps {
  accountId: number
  accountLabel: string
  canEdit: boolean
  policy?: AccountResiliencePolicy
  semaphore?: AccountSemaphoreSnapshot
}

export default function AccountResilienceControls({
  accountId,
  accountLabel,
  canEdit,
  policy,
  semaphore,
}: AccountResilienceControlsProps) {
  const t = useAccountResilienceStrings()
  const queryClient = useQueryClient()

  const effectiveWeight = policy?.weight ?? DEFAULT_CREDENTIAL_WEIGHT
  const effectiveMaxConcurrency = policy?.maxConcurrency ?? semaphore?.maxConcurrency ?? null
  const effectiveFailFast = policy?.failFast ?? false
  const running = semaphore?.running ?? 0
  const queued = semaphore?.queued ?? 0

  const [weightDraft, setWeightDraft] = useState<string | null>(null)
  const [concurrencyDraft, setConcurrencyDraft] = useState<string | null>(null)
  const [failFastDraft, setFailFastDraft] = useState<boolean | null>(null)
  const [validationError, setValidationError] = useState<string | null>(null)
  const [savedNotice, setSavedNotice] = useState<string | null>(null)

  const displayedWeight = weightDraft ?? String(effectiveWeight)
  const displayedConcurrency =
    concurrencyDraft ?? (effectiveMaxConcurrency !== null ? String(effectiveMaxConcurrency) : '')
  const displayedFailFast = failFastDraft ?? effectiveFailFast

  const circuitUntilIso = policy?.refreshCircuitUntil ?? null
  const circuitUntilMs = circuitUntilIso ? Date.parse(circuitUntilIso) : Number.NaN
  const failureCount = policy?.refreshFailureCount ?? 0
  const isCircuitInBackoff = Number.isFinite(circuitUntilMs) && circuitUntilMs > 0 && failureCount > 0
  const hasCircuitWarning = isCircuitInBackoff || failureCount > 0

  const isDraining = effectiveWeight === 0
  const isSaturated =
    (effectiveMaxConcurrency !== null && effectiveMaxConcurrency > 0 && running >= effectiveMaxConcurrency)
    || queued > 0

  const saveMutation = useMutation({
    meta: { silenceToast: true },
    mutationFn: (vars: { weight: number; maxConcurrency: number | null; failFast: boolean }) =>
      updateAccountResilience(accountId, vars),
    onSuccess: async () => {
      setWeightDraft(null)
      setConcurrencyDraft(null)
      setFailFastDraft(null)
      setValidationError(null)
      setSavedNotice(t.savedResilience)
      await queryClient.invalidateQueries({ queryKey: ['x-account-resilience'] })
    },
    onError: (err: Error) => {
      setValidationError(err.message)
    },
  })

  const resetCircuitMutation = useMutation({
    meta: { silenceToast: true },
    mutationFn: () => resetAccountRefreshCircuit(accountId),
    onSuccess: async () => {
      setValidationError(null)
      setSavedNotice(t.circuitResetDone)
      await queryClient.invalidateQueries({ queryKey: ['x-account-resilience'] })
    },
    onError: (err: Error) => {
      setValidationError(err.message)
    },
  })

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSavedNotice(null)

    const rawWeight = displayedWeight.trim()
    if (!/^\d+$/.test(rawWeight)) {
      setValidationError(t.invalidWeight)
      return
    }
    const parsedWeight = Number(rawWeight)
    if (
      !Number.isSafeInteger(parsedWeight)
      || parsedWeight < MIN_CREDENTIAL_WEIGHT
      || parsedWeight > MAX_CREDENTIAL_WEIGHT
    ) {
      setValidationError(t.invalidWeight)
      return
    }

    const rawConcurrency = displayedConcurrency.trim()
    let parsedConcurrency: number | null = null
    if (rawConcurrency !== '' && rawConcurrency !== '0') {
      if (!/^\d+$/.test(rawConcurrency)) {
        setValidationError(t.invalidConcurrency)
        return
      }
      const num = Number(rawConcurrency)
      if (!Number.isSafeInteger(num) || num < 1 || num > MAX_ACCOUNT_CONCURRENCY) {
        setValidationError(t.invalidConcurrency)
        return
      }
      parsedConcurrency = num
    }

    setValidationError(null)
    saveMutation.mutate({
      weight: parsedWeight,
      maxConcurrency: parsedConcurrency,
      failFast: displayedFailFast,
    })
  }

  const handleQuickDrainToggle = () => {
    setSavedNotice(null)
    setValidationError(null)
    const nextWeight = effectiveWeight === 0 ? DEFAULT_CREDENTIAL_WEIGHT : 0
    saveMutation.mutate({
      weight: nextWeight,
      maxConcurrency: effectiveMaxConcurrency,
      failFast: effectiveFailFast,
    })
  }

  const liveBadgeText = t.liveSlotsBadge
    .replace('{running}', String(running))
    .replace('{queued}', String(queued))
  const capText =
    effectiveMaxConcurrency !== null
      ? t.liveCapSuffix.replace('{max}', String(effectiveMaxConcurrency))
      : t.unlimitedBadge

  const formattedUntil =
    circuitUntilIso && Number.isFinite(circuitUntilMs)
      ? new Date(circuitUntilMs).toISOString().slice(11, 19) + 'Z'
      : null

  return (
    <div
      className="x-account-resilience"
      data-testid={`account-resilience-${accountId}`}
      style={{
        marginTop: '0.5rem',
        paddingTop: '0.5rem',
        borderTop: '1px solid var(--x-border, var(--border))',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.45rem',
        fontSize: '0.8125rem',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.45rem' }}>
        <span
          className="x-badge"
          data-testid={`account-sem-badge-${accountId}`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontFamily: 'monospace',
            color: isSaturated ? '#f59e0b' : undefined,
            borderColor: isSaturated ? 'rgba(245, 158, 11, 0.35)' : undefined,
          }}
        >
          <Activity size={12} />
          {liveBadgeText} · {capText}
        </span>

        {isDraining ? (
          <span
            className="x-badge"
            data-testid={`account-drain-badge-${accountId}`}
            title={t.weightHint}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              color: '#f59e0b',
              background: 'rgba(245, 158, 11, 0.1)',
              borderColor: 'rgba(245, 158, 11, 0.35)',
            }}
          >
            <Scale size={12} />
            {t.drainBadge}
          </span>
        ) : (
          <span
            className="x-badge"
            data-testid={`account-weight-badge-${accountId}`}
            title={t.weightHint}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            <Scale size={12} />
            {t.weightLabel}: {effectiveWeight}
          </span>
        )}

        {hasCircuitWarning ? (
          <span
            className="x-badge"
            data-testid={`account-circuit-badge-${accountId}`}
            title={policy?.lastRefreshError ?? undefined}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              color: '#ef4444',
              background: 'rgba(239, 68, 68, 0.1)',
              borderColor: 'rgba(239, 68, 68, 0.35)',
            }}
          >
            <AlertTriangle size={12} />
            {t.circuitBackoff.replace('{failures}', String(failureCount))}
            {formattedUntil ? ` · ${t.circuitUntil.replace('{until}', formattedUntil)}` : ''}
          </span>
        ) : (
          <span
            className="x-badge"
            data-testid={`account-circuit-badge-${accountId}`}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, opacity: 0.85 }}
          >
            <Gauge size={12} />
            {t.circuitHealthy}
          </span>
        )}

        {canEdit && hasCircuitWarning && (
          <button
            type="button"
            className="x-button x-small"
            data-testid={`account-reset-circuit-${accountId}`}
            disabled={resetCircuitMutation.isPending}
            onClick={() => {
              setSavedNotice(null)
              resetCircuitMutation.mutate()
            }}
            style={{ padding: '2px 8px', fontSize: '0.75rem' }}
          >
            <RotateCcw size={12} />
            {resetCircuitMutation.isPending ? t.resettingCircuit : t.resetCircuit}
          </button>
        )}
      </div>

      {policy?.lastRefreshError && hasCircuitWarning && (
        <div
          data-testid={`account-circuit-error-${accountId}`}
          style={{ fontSize: '0.75rem', color: '#ef4444' }}
        >
          {policy.lastRefreshError}
        </div>
      )}

      {canEdit && (
        <form
          onSubmit={handleSubmit}
          style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}
        >
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span>{t.weightLabel}:</span>
            <input
              type="number"
              min={MIN_CREDENTIAL_WEIGHT}
              max={MAX_CREDENTIAL_WEIGHT}
              step={1}
              aria-label={`${t.weightLabel} ${accountLabel}`}
              value={displayedWeight}
              onChange={e => {
                setSavedNotice(null)
                setWeightDraft(e.target.value)
              }}
              title={t.weightHint}
              style={{
                width: '74px',
                padding: '2px 6px',
                borderRadius: 6,
                border: '1px solid var(--x-border, var(--border))',
                background: 'var(--x-surface, transparent)',
                color: 'var(--x-ink, inherit)',
              }}
            />
          </label>

          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span>{t.maxConcurrencyLabel}:</span>
            <input
              type="number"
              min={0}
              max={MAX_ACCOUNT_CONCURRENCY}
              step={1}
              placeholder={t.unlimitedPlaceholder}
              aria-label={`${t.maxConcurrencyLabel} ${accountLabel}`}
              value={displayedConcurrency}
              onChange={e => {
                setSavedNotice(null)
                setConcurrencyDraft(e.target.value)
              }}
              style={{
                width: '96px',
                padding: '2px 6px',
                borderRadius: 6,
                border: '1px solid var(--x-border, var(--border))',
                background: 'var(--x-surface, transparent)',
                color: 'var(--x-ink, inherit)',
              }}
            />
          </label>

          <label
            title={t.failFastHint}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}
          >
            <input
              type="checkbox"
              aria-label={`${t.failFastLabel} ${accountLabel}`}
              checked={displayedFailFast}
              onChange={e => {
                setSavedNotice(null)
                setFailFastDraft(e.target.checked)
              }}
            />
            <span>{t.failFastLabel}</span>
          </label>

          <button
            type="submit"
            className="x-button x-small"
            data-testid={`account-save-resilience-${accountId}`}
            disabled={saveMutation.isPending}
            style={{ padding: '2px 8px', fontSize: '0.75rem' }}
          >
            {saveMutation.isPending ? t.savingResilience : t.saveResilience}
          </button>

          <button
            type="button"
            className="x-button x-small"
            data-testid={`account-drain-toggle-${accountId}`}
            disabled={saveMutation.isPending}
            onClick={handleQuickDrainToggle}
            style={{ padding: '2px 8px', fontSize: '0.75rem' }}
          >
            {effectiveWeight === 0 ? t.restoreWeightAction : t.drainAction}
          </button>

          {savedNotice && (
            <span
              className="x-test-ok"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.75rem' }}
            >
              <CircleCheck size={13} />
              {savedNotice}
            </span>
          )}
        </form>
      )}

      {validationError && (
        <div role="alert" style={{ color: '#ef4444', fontSize: '0.75rem' }}>
          {validationError}
        </div>
      )}
    </div>
  )
}
