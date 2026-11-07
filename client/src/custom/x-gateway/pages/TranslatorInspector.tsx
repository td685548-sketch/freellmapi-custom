import { useState, useEffect, useMemo } from 'react';
import {
  AlertTriangle,
  ArrowLeftRight,
  Check,
  CheckCircle2,
  Copy,
  Info,
  Play,
  RotateCcw,
  Sparkles,
  Zap,
} from 'lucide-react';
import { useTranslatorStrings } from '../translator-strings';
import {
  useInspectTranslation,
  useDispatchTranslation,
  useTranslatorTemplates,
} from '../translator-api';
import type {
  PipelineStep,
  ProtocolType,
  TranslatorTemplate,
} from '../translator-types';

const PROTOCOL_OPTIONS: Array<{ value: ProtocolType; labelKey: keyof ReturnType<typeof useTranslatorStrings> }> = [
  { value: 'openai_chat', labelKey: 'protocolOpenAIChat' },
  { value: 'anthropic', labelKey: 'protocolAnthropic' },
  { value: 'openai_responses', labelKey: 'protocolOpenAIResponses' },
  { value: 'gemini', labelKey: 'protocolGemini' },
  { value: 'sse_openai', labelKey: 'protocolSseOpenAI' },
  { value: 'sse_anthropic', labelKey: 'protocolSseAnthropic' },
];

const DEFAULT_OPENAI_PAYLOAD = {
  model: 'gpt-4o',
  messages: [
    { role: 'system', content: 'You are an AI assistant specialized in cross-protocol translation.' },
    { role: 'user', content: 'Explain how 9Router standardizes OpenAI and Anthropic formats.' },
  ],
  temperature: 0.7,
  max_tokens: 1024,
};

export default function TranslatorInspector() {
  const s = useTranslatorStrings();
  const [sourceProtocol, setSourceProtocol] = useState<ProtocolType>('openai_chat');
  const [targetProtocol, setTargetProtocol] = useState<ProtocolType>('anthropic');
  const [jsonInput, setJsonInput] = useState<string>(() => JSON.stringify(DEFAULT_OPENAI_PAYLOAD, null, 2));
  const [copied, setCopied] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<'pipeline' | 'json' | 'dispatch'>('pipeline');

  const templatesQuery = useTranslatorTemplates();
  const inspectMutation = useInspectTranslation();
  const dispatchMutation = useDispatchTranslation();

  // Validate JSON input syntax
  const parseValidation = useMemo(() => {
    try {
      const parsed = JSON.parse(jsonInput);
      if (typeof parsed !== 'object' || parsed === null) {
        return { valid: false, error: 'Payload must be a JSON object', parsed: null };
      }
      return { valid: true, error: null, parsed };
    } catch (e: unknown) {
      return {
        valid: false,
        error: e instanceof Error ? e.message : 'Invalid JSON syntax',
        parsed: null,
      };
    }
  }, [jsonInput]);

  // Execute translation inspection when valid payload, source, or target changes
  useEffect(() => {
    if (!parseValidation.valid || !parseValidation.parsed) return;
    const timer = setTimeout(() => {
      inspectMutation.mutate({
        sourceProtocol,
        targetProtocol,
        payload: parseValidation.parsed as Record<string, unknown>,
      });
    }, 250);
    return () => clearTimeout(timer);
  }, [sourceProtocol, targetProtocol, parseValidation.valid, parseValidation.parsed]);

  const handleSwap = () => {
    const prevSource = sourceProtocol;
    const prevTarget = targetProtocol;
    setSourceProtocol(prevTarget);
    setTargetProtocol(prevSource);
    // If we have an existing transformed payload, set it as input
    if (inspectMutation.data?.transformed) {
      setJsonInput(JSON.stringify(inspectMutation.data.transformed, null, 2));
    }
  };

  const handleBeautify = () => {
    if (parseValidation.valid && parseValidation.parsed) {
      setJsonInput(JSON.stringify(parseValidation.parsed, null, 2));
    }
  };

  const handleClear = () => {
    setJsonInput('{\n  \n}');
  };

  const handleSelectTemplate = (template: TranslatorTemplate) => {
    setSourceProtocol(template.protocol);
    // pick complementary target protocol
    if (template.protocol === 'sse_openai') {
      setTargetProtocol('sse_anthropic');
    } else if (template.protocol === 'sse_anthropic') {
      setTargetProtocol('sse_openai');
    } else if (template.protocol === 'anthropic') {
      setTargetProtocol('openai_chat');
    } else {
      setTargetProtocol('anthropic');
    }
    setJsonInput(JSON.stringify(template.payload, null, 2));
  };

  const handleCopyTransformed = () => {
    if (!inspectMutation.data?.transformed) return;
    navigator.clipboard.writeText(JSON.stringify(inspectMutation.data.transformed, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDispatch = () => {
    if (!parseValidation.valid || !parseValidation.parsed) return;
    dispatchMutation.mutate({
      protocol: sourceProtocol,
      payload: parseValidation.parsed as Record<string, unknown>,
    });
  };

  const renderStepIcon = (step: PipelineStep) => {
    switch (step.status) {
      case 'ok':
        return <CheckCircle2 size={18} style={{ color: 'var(--x-green)' }} />;
      case 'warn':
        return <AlertTriangle size={18} style={{ color: '#d97706' }} />;
      case 'error':
        return <AlertTriangle size={18} style={{ color: 'var(--x-red)' }} />;
      case 'info':
      default:
        return <Info size={18} style={{ color: 'var(--x-primary)' }} />;
    }
  };

  const stats = inspectMutation.data?.stats;

  return (
    <div className="x-page">
      <div className="x-page-heading">
        <div>
          <div className="x-eyebrow">9Router Engine</div>
          <h1>{s.translatorTitle}</h1>
          <p>{s.translatorHelp}</p>
        </div>
        <span className="x-heading-icon">
          <ArrowLeftRight size={28} />
        </span>
      </div>

      {/* Top Protocol & Toolbar */}
      <div className="x-panel" style={{ padding: '16px 20px', marginBottom: '20px' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', flex: 1 }}>
            {/* Source Protocol */}
            <div style={{ minWidth: '220px' }}>
              <label style={{ display: 'block', fontSize: '11px', fontWeight: 600, color: 'var(--x-muted)', marginBottom: '4px', textTransform: 'uppercase' }}>
                {s.sourceProtocol}
              </label>
              <select
                className="x-input"
                value={sourceProtocol}
                onChange={(e) => setSourceProtocol(e.target.value as ProtocolType)}
                style={{ width: '100%', padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--x-border)', background: 'var(--x-bg)' }}
              >
                {PROTOCOL_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {s[opt.labelKey]}
                  </option>
                ))}
              </select>
            </div>

            {/* Swap Button */}
            <div style={{ paddingTop: '18px' }}>
              <button
                type="button"
                className="x-button"
                onClick={handleSwap}
                title={s.swapProtocols}
                style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                <ArrowLeftRight size={16} />
              </button>
            </div>

            {/* Target Protocol */}
            <div style={{ minWidth: '220px' }}>
              <label style={{ display: 'block', fontSize: '11px', fontWeight: 600, color: 'var(--x-muted)', marginBottom: '4px', textTransform: 'uppercase' }}>
                {s.targetProtocol}
              </label>
              <select
                className="x-input"
                value={targetProtocol}
                onChange={(e) => setTargetProtocol(e.target.value as ProtocolType)}
                style={{ width: '100%', padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--x-border)', background: 'var(--x-bg)' }}
              >
                {PROTOCOL_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {s[opt.labelKey]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Templates & Editor Quick Actions */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            {templatesQuery.data?.templates && (
              <select
                className="x-input"
                onChange={(e) => {
                  const tmpl = templatesQuery.data?.templates.find((t) => t.id === e.target.value);
                  if (tmpl) handleSelectTemplate(tmpl);
                }}
                defaultValue=""
                style={{ padding: '8px 12px', borderRadius: '8px', border: '1px solid var(--x-border)', background: 'var(--x-bg)', fontSize: '12px' }}
              >
                <option value="" disabled>
                  {s.selectTemplate}
                </option>
                {templatesQuery.data.templates.map((tmpl) => (
                  <option key={tmpl.id} value={tmpl.id}>
                    {tmpl.name}
                  </option>
                ))}
              </select>
            )}

            <button
              type="button"
              className="x-button"
              onClick={handleBeautify}
              disabled={!parseValidation.valid}
              title={s.beautifyJson}
              style={{ fontSize: '12px', padding: '8px 12px' }}
            >
              <Sparkles size={14} style={{ marginRight: '6px' }} />
              {s.beautifyJson}
            </button>

            <button
              type="button"
              className="x-button"
              onClick={handleClear}
              title={s.clear}
              style={{ fontSize: '12px', padding: '8px 12px' }}
            >
              <RotateCcw size={14} style={{ marginRight: '6px' }} />
              {s.clear}
            </button>
          </div>
        </div>
      </div>

      {/* Main Dual-Pane Workspace */}
      <div className="x-playground-grid" style={{ alignItems: 'start' }}>
        {/* Left Pane: Source Payload Editor */}
        <div className="x-panel" style={{ padding: '20px', display: 'flex', flexDirection: 'column', minHeight: '620px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <h2 style={{ fontSize: '15px', fontWeight: 600, margin: 0 }}>
              {s.inputPayload}
            </h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                  padding: '2px 8px',
                  borderRadius: '6px',
                  fontSize: '11px',
                  fontWeight: 600,
                  background: parseValidation.valid ? 'var(--x-green-bg)' : 'var(--x-red-bg)',
                  color: parseValidation.valid ? 'var(--x-green)' : 'var(--x-red)',
                }}
              >
                {parseValidation.valid ? <Check size={12} /> : <AlertTriangle size={12} />}
                {parseValidation.valid ? s.validJson : s.invalidJson}
              </span>
            </div>
          </div>

          <textarea
            className="x-input"
            value={jsonInput}
            onChange={(e) => setJsonInput(e.target.value)}
            spellCheck={false}
            style={{
              flex: 1,
              width: '100%',
              minHeight: '480px',
              fontFamily: 'monospace',
              fontSize: '13px',
              lineHeight: 1.5,
              padding: '14px',
              borderRadius: '8px',
              border: `1px solid ${parseValidation.valid ? 'var(--x-border)' : 'var(--x-red)'}`,
              background: 'var(--x-bg)',
              color: 'var(--x-text)',
              resize: 'vertical',
            }}
          />

          {parseValidation.error && (
            <p style={{ margin: '8px 0 0', color: 'var(--x-red)', fontSize: '12px' }}>
              {parseValidation.error}
            </p>
          )}

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '12px', fontSize: '12px', color: 'var(--x-muted)' }}>
            <span>{jsonInput.length} characters</span>
            {stats && (
              <span>
                {s.sourceTokens}: <strong>~{stats.sourceTokens}</strong>
              </span>
            )}
          </div>
        </div>

        {/* Right Pane: 7-Step Pipeline Inspector & Transformed Output */}
        <div className="x-panel" style={{ padding: '20px', display: 'flex', flexDirection: 'column', minHeight: '620px' }}>
          {/* Tabs */}
          <div style={{ display: 'flex', gap: '8px', borderBottom: '1px solid var(--x-border)', paddingBottom: '12px', marginBottom: '16px' }}>
            <button
              type="button"
              onClick={() => setActiveTab('pipeline')}
              className={`x-button ${activeTab === 'pipeline' ? 'x-primary' : ''}`}
              style={{ fontSize: '12px', padding: '6px 14px' }}
            >
              {s.pipelineTabTitle}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('json')}
              className={`x-button ${activeTab === 'json' ? 'x-primary' : ''}`}
              style={{ fontSize: '12px', padding: '6px 14px' }}
            >
              {s.transformedTabTitle}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('dispatch')}
              className={`x-button ${activeTab === 'dispatch' ? 'x-primary' : ''}`}
              style={{ fontSize: '12px', padding: '6px 14px' }}
            >
              <Zap size={13} style={{ marginRight: '5px' }} />
              {s.dispatchTabTitle}
            </button>
          </div>

          {/* Stats Bar */}
          {stats && (
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '12px',
                alignItems: 'center',
                padding: '10px 14px',
                borderRadius: '8px',
                background: 'var(--x-alt)',
                marginBottom: '16px',
                fontSize: '12px',
              }}
            >
              <div>
                {s.targetTokens}: <strong>~{stats.targetTokens}</strong>
              </div>
              <div style={{ color: stats.delta >= 0 ? 'var(--x-primary)' : 'var(--x-green)' }}>
                {s.tokenDelta}: <strong>{stats.delta >= 0 ? `+${stats.delta}` : stats.delta}</strong>
              </div>
              {stats.warnings.length > 0 && (
                <div style={{ color: '#d97706', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <AlertTriangle size={14} />
                  <span>
                    {stats.warnings.length} {s.warningsCount}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Tab 1: Pipeline Trace */}
          {activeTab === 'pipeline' && (
            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {inspectMutation.isPending && (
                <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--x-muted)' }}>
                  <p>{s.inspecting}</p>
                </div>
              )}

              {inspectMutation.data?.steps && inspectMutation.data.steps.map((step) => (
                <div
                  key={step.step}
                  style={{
                    border: '1px solid var(--x-border)',
                    borderRadius: '8px',
                    padding: '12px 14px',
                    background: 'var(--x-bg)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          width: '20px',
                          height: '20px',
                          borderRadius: '50%',
                          background: 'var(--x-tint)',
                          color: 'var(--x-primary)',
                          fontSize: '11px',
                          fontWeight: 700,
                        }}
                      >
                        {step.step}
                      </span>
                      <strong style={{ fontSize: '13px' }}>{step.name}</strong>
                    </div>
                    {renderStepIcon(step)}
                  </div>
                  <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--x-text)', marginTop: '4px' }}>
                    {step.title}
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--x-muted)', marginTop: '2px', lineHeight: 1.4 }}>
                    {step.details}
                  </div>
                </div>
              ))}

              {!inspectMutation.data && !inspectMutation.isPending && (
                <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--x-muted)' }}>
                  <p>{s.emptyOutputHelp}</p>
                </div>
              )}
            </div>
          )}

          {/* Tab 2: Transformed JSON */}
          {activeTab === 'json' && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '8px' }}>
                <button
                  type="button"
                  className="x-button"
                  onClick={handleCopyTransformed}
                  disabled={!inspectMutation.data?.transformed}
                  style={{ fontSize: '12px', padding: '6px 12px' }}
                >
                  {copied ? <Check size={14} style={{ marginRight: '6px' }} /> : <Copy size={14} style={{ marginRight: '6px' }} />}
                  {copied ? s.copied : s.copyJson}
                </button>
              </div>
              <pre
                style={{
                  flex: 1,
                  margin: 0,
                  padding: '14px',
                  borderRadius: '8px',
                  border: '1px solid var(--x-border)',
                  background: 'var(--x-bg)',
                  color: 'var(--x-text)',
                  fontFamily: 'monospace',
                  fontSize: '12px',
                  lineHeight: 1.45,
                  overflow: 'auto',
                  maxHeight: '500px',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {inspectMutation.data?.transformed
                  ? JSON.stringify(inspectMutation.data.transformed, null, 2)
                  : s.emptyOutputHelp}
              </pre>
            </div>
          )}

          {/* Tab 3: Gateway Dispatch Test */}
          {activeTab === 'dispatch' && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div style={{ padding: '16px', borderRadius: '8px', background: 'var(--x-alt)', border: '1px solid var(--x-border)' }}>
                <h3 style={{ margin: '0 0 8px', fontSize: '14px', fontWeight: 600 }}>
                  {s.sendToGateway}
                </h3>
                <p style={{ margin: '0 0 14px', fontSize: '12px', color: 'var(--x-muted)' }}>
                  Simulate dispatching this request against local X Gateway routing tables without consuming external provider quotas.
                </p>
                <button
                  type="button"
                  className="x-button x-primary"
                  onClick={handleDispatch}
                  disabled={!parseValidation.valid || dispatchMutation.isPending}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}
                >
                  <Play size={14} />
                  {dispatchMutation.isPending ? s.dispatching : s.testDispatch}
                </button>
              </div>

              {dispatchMutation.data && (
                <div
                  style={{
                    padding: '16px',
                    borderRadius: '8px',
                    border: '1px solid var(--x-green)',
                    background: 'var(--x-green-bg)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '8px',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--x-green)', fontWeight: 600 }}>
                    <CheckCircle2 size={18} />
                    <span>{s.dispatchSuccess}</span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '10px', marginTop: '4px', fontSize: '12px' }}>
                    <div>
                      {s.latency}: <strong>{dispatchMutation.data.latencyMs} ms</strong>
                    </div>
                    <div>
                      {s.availableKeys}: <strong>{dispatchMutation.data.availableAccounts}</strong>
                    </div>
                    <div>
                      Model: <strong>{dispatchMutation.data.model}</strong>
                    </div>
                  </div>
                  <p style={{ margin: '6px 0 0', fontSize: '12px', color: 'var(--x-text)' }}>
                    {dispatchMutation.data.note}
                  </p>
                </div>
              )}

              {dispatchMutation.isError && (
                <div
                  style={{
                    padding: '16px',
                    borderRadius: '8px',
                    border: '1px solid var(--x-red)',
                    background: 'var(--x-red-bg)',
                    color: 'var(--x-red)',
                    fontSize: '12px',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600, marginBottom: '4px' }}>
                    <AlertTriangle size={18} />
                    <span>{s.dispatchError}</span>
                  </div>
                  <p style={{ margin: 0 }}>{dispatchMutation.error.message}</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
