import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, Cpu, Play, RotateCcw, Save, ShieldCheck } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import {
  AGENTIC_PROSE_MODES,
  AGENTIC_STRATEGY_IDS,
  DEFAULT_AGENTIC_COMPACTOR_CONFIG,
  type AgenticCompactorConfig,
  type AgenticCompactorStatusResponse,
  type AgenticPreviewRequest,
  type AgenticPreviewResponse,
  type AgenticProseMode,
} from '@freellmapi/shared/token-savers-agentic.js';
import { useSessionRevision } from '../../session-state';
import {
  AGENTIC_PREVIEW_PRESETS,
  useAgenticCompactorStrings,
} from '../token-savers-agentic-strings';

interface AgenticCompactorPanelProps {
  canEdit: boolean;
}

export default function AgenticCompactorPanel({ canEdit }: AgenticCompactorPanelProps) {
  const t = useAgenticCompactorStrings();
  const client = useQueryClient();
  const revision = useSessionRevision();

  const statusQuery = useQuery({
    queryKey: ['x-agentic-compactor', revision],
    queryFn: ({ signal }) => apiFetch<AgenticCompactorStatusResponse>('/api/savers/agentic', { signal }),
    refetchInterval: 30_000,
    retry: false,
  });

  const [draft, setDraft] = useState<AgenticCompactorConfig | null>(null);
  const [sandboxOpen, setSandboxOpen] = useState(false);
  const [previewRole, setPreviewRole] = useState<'tool' | 'user'>('tool');
  const [previewText, setPreviewText] = useState<string>(AGENTIC_PREVIEW_PRESETS[0]?.text ?? '');

  const serverConfig: AgenticCompactorConfig = {
    ...DEFAULT_AGENTIC_COMPACTOR_CONFIG,
    ...(statusQuery.data?.config ?? {}),
  };
  const effectiveConfig: AgenticCompactorConfig = draft ?? serverConfig;
  const stats = statusQuery.data?.stats;
  const strategyHits = stats?.strategyHits;

  const saveMutation = useMutation({
    meta: { silenceToast: true },
    mutationFn: (nextConfig: AgenticCompactorConfig) => {
      const payload = {
        enabled: nextConfig.enabled,
        toolCompaction: nextConfig.toolCompaction,
        toolResultMaxChars: nextConfig.toolResultMaxChars,
        jsonMinChars: nextConfig.jsonMinChars,
        proseMode: nextConfig.proseMode,
        prefixFreezeEnabled: nextConfig.prefixFreezeEnabled,
        prefixFreezeThreshold: nextConfig.prefixFreezeThreshold,
        dedupTools: nextConfig.dedupTools,
      };
      return apiFetch<AgenticCompactorStatusResponse>('/api/savers/agentic', {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
    },
    onSuccess: async () => {
      setDraft(null);
      await client.invalidateQueries({ queryKey: ['x-agentic-compactor'] });
    },
  });

  const resetStatsMutation = useMutation({
    meta: { silenceToast: true },
    mutationFn: () =>
      apiFetch<{ ok: boolean }>('/api/savers/agentic/reset', {
        method: 'POST',
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['x-agentic-compactor'] });
    },
  });

  const previewMutation = useMutation({
    meta: { silenceToast: true },
    mutationFn: (body: AgenticPreviewRequest) =>
      apiFetch<AgenticPreviewResponse>('/api/savers/agentic/preview', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  });

  const updateDraft = (patch: Partial<AgenticCompactorConfig>) => {
    setDraft({ ...effectiveConfig, ...patch });
    saveMutation.reset();
  };

  return (
    <section
      className="x-panel"
      style={{ marginTop: '1.25rem', padding: '1.25rem' }}
      data-testid="agentic-compactor-panel"
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '0.75rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          <Cpu size={22} color="#10b981" />
          <div>
            <h2 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 600 }}>{t.title}</h2>
            <p style={{ margin: '0.2rem 0 0', fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
              {t.subtitle}
            </p>
          </div>
        </div>

        <button
          type="button"
          className="x-switch"
          role="switch"
          aria-label={t.title}
          aria-checked={effectiveConfig.enabled}
          disabled={!canEdit || saveMutation.isPending}
          onClick={() => {
            const toggled = { ...effectiveConfig, enabled: !effectiveConfig.enabled };
            setDraft(toggled);
            saveMutation.mutate(toggled);
          }}
        >
          <span />
        </button>
      </div>

      {/* Configuration Grid */}
      <div
        style={{
          marginTop: '1rem',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '0.75rem',
          fontSize: '0.8125rem',
        }}
      >
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <input
            type="checkbox"
            checked={effectiveConfig.toolCompaction}
            disabled={!canEdit || saveMutation.isPending}
            onChange={e => updateDraft({ toolCompaction: e.target.checked })}
          />
          {t.toolCompaction}
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <input
            type="checkbox"
            checked={effectiveConfig.dedupTools}
            disabled={!canEdit || saveMutation.isPending}
            onChange={e => updateDraft({ dedupTools: e.target.checked })}
          />
          {t.dedupTools}
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <input
            type="checkbox"
            checked={effectiveConfig.prefixFreezeEnabled}
            disabled={!canEdit || saveMutation.isPending}
            onChange={e => updateDraft({ prefixFreezeEnabled: e.target.checked })}
          />
          {t.prefixFreeze}
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <span>{t.proseMode}</span>
          <select
            value={effectiveConfig.proseMode}
            disabled={!canEdit || saveMutation.isPending}
            onChange={e => updateDraft({ proseMode: e.target.value as AgenticProseMode })}
            style={{
              padding: '0.375rem 0.5rem',
              borderRadius: '6px',
              border: '1px solid var(--border)',
              backgroundColor: 'var(--bg-subtle, rgba(0,0,0,0.05))',
            }}
          >
            {AGENTIC_PROSE_MODES.map(mode => (
              <option key={mode} value={mode}>
                {t.proseModes[mode]}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <span>{t.toolResultMaxChars}</span>
          <input
            type="number"
            min={1000}
            max={200000}
            step={1000}
            value={effectiveConfig.toolResultMaxChars}
            disabled={!canEdit || saveMutation.isPending}
            onChange={e => updateDraft({ toolResultMaxChars: Number(e.target.value) || 12000 })}
            style={{
              padding: '0.375rem 0.5rem',
              borderRadius: '6px',
              border: '1px solid var(--border)',
              backgroundColor: 'var(--bg-subtle, rgba(0,0,0,0.05))',
            }}
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <span>{t.jsonMinChars}</span>
          <input
            type="number"
            min={500}
            max={100000}
            step={500}
            value={effectiveConfig.jsonMinChars}
            disabled={!canEdit || saveMutation.isPending}
            onChange={e => updateDraft({ jsonMinChars: Number(e.target.value) || 2000 })}
            style={{
              padding: '0.375rem 0.5rem',
              borderRadius: '6px',
              border: '1px solid var(--border)',
              backgroundColor: 'var(--bg-subtle, rgba(0,0,0,0.05))',
            }}
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <span>{t.prefixFreezeThreshold}</span>
          <input
            type="number"
            min={1}
            max={50}
            value={effectiveConfig.prefixFreezeThreshold}
            disabled={!canEdit || saveMutation.isPending}
            onChange={e => updateDraft({ prefixFreezeThreshold: Number(e.target.value) || 3 })}
            style={{
              padding: '0.375rem 0.5rem',
              borderRadius: '6px',
              border: '1px solid var(--border)',
              backgroundColor: 'var(--bg-subtle, rgba(0,0,0,0.05))',
            }}
          />
        </label>
      </div>

      {/* Action Buttons */}
      <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
        {canEdit && (
          <>
            <button
              type="button"
              className="x-button x-small x-primary"
              disabled={!draft || saveMutation.isPending}
              onClick={() => saveMutation.mutate(effectiveConfig)}
            >
              <Save size={14} />
              {saveMutation.isPending ? t.saving : t.saveConfig}
            </button>
            <button
              type="button"
              className="x-button x-small"
              disabled={resetStatsMutation.isPending}
              onClick={() => resetStatsMutation.mutate()}
            >
              <RotateCcw size={14} />
              {t.resetStats}
            </button>
          </>
        )}

        <button
          type="button"
          className="x-button x-small"
          onClick={() => setSandboxOpen(open => !open)}
        >
          {sandboxOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          {sandboxOpen ? t.sandboxToggleHide : t.sandboxToggleShow}
        </button>

        {saveMutation.isSuccess && (
          <span role="status" className="x-test-ok" style={{ margin: 0 }}>
            {t.savedOk}
          </span>
        )}
        {saveMutation.isError && (
          <span role="alert" className="x-error" style={{ margin: 0 }}>
            {saveMutation.error instanceof Error ? saveMutation.error.message : 'Save failed'}
          </span>
        )}
      </div>

      {/* Live Telemetry Summary */}
      <div
        style={{
          marginTop: '1rem',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: '0.6rem',
        }}
      >
        <div className="x-panel" style={{ padding: '0.6rem', textAlign: 'center' }}>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{t.statProcessed}</div>
          <div style={{ fontSize: '1.1rem', fontWeight: 600 }}>{stats?.requestsProcessed ?? 0}</div>
        </div>
        <div className="x-panel" style={{ padding: '0.6rem', textAlign: 'center' }}>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{t.statCompressed}</div>
          <div style={{ fontSize: '1.1rem', fontWeight: 600 }}>{stats?.requestsCompressed ?? 0}</div>
        </div>
        <div className="x-panel" style={{ padding: '0.6rem', textAlign: 'center' }}>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{t.statTokensSaved}</div>
          <div style={{ fontSize: '1.1rem', fontWeight: 600, color: '#10b981' }}>
            {Number(stats?.tokensSavedEst ?? 0).toLocaleString()}
          </div>
        </div>
        <div className="x-panel" style={{ padding: '0.6rem', textAlign: 'center' }}>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{t.statFrozen}</div>
          <div style={{ fontSize: '1.1rem', fontWeight: 600 }}>
            {stats?.frozenPrefixesSkipped ?? 0}
          </div>
        </div>
        <div className="x-panel" style={{ padding: '0.6rem', textAlign: 'center' }}>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{t.statRollbacks}</div>
          <div style={{ fontSize: '1.1rem', fontWeight: 600 }}>{stats?.fidelityRollbacks ?? 0}</div>
        </div>
      </div>

      {/* Strategy Hits Strip */}
      <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.4rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginRight: '0.25rem' }}>
          {t.strategiesHeading}:
        </span>
        {AGENTIC_STRATEGY_IDS.map(strategy => (
          <span
            key={strategy}
            style={{
              fontSize: '0.75rem',
              padding: '0.15rem 0.5rem',
              borderRadius: '999px',
              background: 'var(--bg-subtle, rgba(0,0,0,0.06))',
            }}
          >
            {t.strategyLabels[strategy]}: <strong>{strategyHits?.[strategy] ?? 0}</strong>
          </span>
        ))}
      </div>

      {/* Collapsible Live Compression Sandbox */}
      {sandboxOpen && (
        <div
          style={{
            marginTop: '1rem',
            paddingTop: '1rem',
            borderTop: '1px solid var(--border)',
          }}
        >
          <p style={{ margin: '0 0 0.6rem', fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
            {t.sandboxHelp}
          </p>

          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.6rem' }}>
            {AGENTIC_PREVIEW_PRESETS.map(preset => (
              <button
                key={preset.id}
                type="button"
                className="x-button x-small"
                onClick={() => {
                  setPreviewRole(preset.role);
                  setPreviewText(preset.text);
                }}
              >
                {t.presetLabels[preset.id]}
              </button>
            ))}

            <select
              value={previewRole}
              onChange={e => setPreviewRole(e.target.value as 'tool' | 'user')}
              style={{
                padding: '0.25rem 0.5rem',
                borderRadius: '6px',
                border: '1px solid var(--border)',
                backgroundColor: 'var(--bg-subtle, rgba(0,0,0,0.05))',
                fontSize: '0.75rem',
              }}
            >
              <option value="tool">{t.roleTool}</option>
              <option value="user">{t.roleUser}</option>
            </select>
          </div>

          <textarea
            rows={5}
            value={previewText}
            onChange={e => setPreviewText(e.target.value)}
            placeholder={t.inputPlaceholder}
            style={{
              width: '100%',
              padding: '0.65rem',
              borderRadius: '8px',
              border: '1px solid var(--border)',
              backgroundColor: 'var(--bg-subtle, rgba(0,0,0,0.03))',
              fontFamily: 'ui-monospace, monospace',
              fontSize: '0.8rem',
              boxSizing: 'border-box',
            }}
          />

          <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <button
              type="button"
              className="x-button x-small x-primary"
              disabled={!previewText.trim() || previewMutation.isPending}
              onClick={() =>
                previewMutation.mutate({
                  role: previewRole,
                  text: previewText,
                  configOverride: effectiveConfig,
                })
              }
            >
              <Play size={14} />
              {previewMutation.isPending ? t.runningPreview : t.runPreview}
            </button>
          </div>

          {previewMutation.data && (
            <div style={{ marginTop: '0.75rem' }} data-testid="agentic-preview-result">
              <div
                style={{
                  display: 'flex',
                  gap: '0.75rem',
                  flexWrap: 'wrap',
                  fontSize: '0.8rem',
                  marginBottom: '0.5rem',
                  alignItems: 'center',
                }}
              >
                <span>
                  {t.beforeAfter}:{' '}
                  <strong>
                    {previewMutation.data.tokensBeforeEst} → {previewMutation.data.tokensAfterEst}
                  </strong>
                </span>
                <span style={{ color: '#10b981', fontWeight: 600 }}>
                  {t.savedRate}: {previewMutation.data.tokensSavedEst} tokens ({previewMutation.data.savedPct}%)
                </span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                  <ShieldCheck size={14} color="#10b981" />
                  {t.protectedSpans}: <strong>{previewMutation.data.protectedSpansCount}</strong>
                </span>
                <span>
                  {t.prefixProtected}: <strong>{previewMutation.data.prefixFrozen ? t.yes : t.no}</strong>
                </span>
                <span>
                  {t.rolledBackFlag}: <strong>{previewMutation.data.fidelityRolledBack ? t.yes : t.no}</strong>
                </span>
              </div>

              {previewMutation.data.strategiesApplied.length > 0 && (
                <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
                  {previewMutation.data.strategiesApplied.map(id => (
                    <span
                      key={id}
                      style={{
                        fontSize: '0.75rem',
                        padding: '0.15rem 0.5rem',
                        borderRadius: '999px',
                        background: 'rgba(16, 185, 129, 0.14)',
                        color: '#10b981',
                        fontWeight: 600,
                      }}
                    >
                      {t.strategyLabels[id]}
                    </span>
                  ))}
                </div>
              )}

              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>
                {t.compressedOutputLabel}
              </div>
              <pre
                style={{
                  margin: 0,
                  padding: '0.65rem',
                  borderRadius: '8px',
                  border: '1px solid var(--border)',
                  backgroundColor: 'var(--bg-subtle, rgba(0,0,0,0.04))',
                  fontSize: '0.78rem',
                  maxHeight: '220px',
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {previewMutation.data.compressedPreview}
              </pre>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
