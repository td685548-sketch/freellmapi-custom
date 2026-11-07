import { useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  ExternalLink,
  Globe,
  Play,
  RefreshCw,
  Square,
  Terminal,
} from 'lucide-react';
import { useTunnelStrings } from '../tunnel-strings';
import {
  useStartTunnel,
  useStopTunnel,
  useTunnelLogs,
  useTunnelStatus,
} from '../tunnel-api';
import { useUserSession } from '../../use-session';

function formatUptime(seconds: number): string {
  if (seconds <= 0) return '0s';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export default function TunnelManager() {
  const s = useTunnelStrings();
  const session = useUserSession();
  const canManage = session.hasPermission('edit_x_settings') || session.hasPermission('manage_x_gateway');

  const { data: status } = useTunnelStatus();
  const { data: logsData, refetch: refetchLogs, isFetching: logsFetching } = useTunnelLogs();
  const startMutation = useStartTunnel();
  const stopMutation = useStopTunnel();

  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [activeSnippetTab, setActiveSnippetTab] = useState<'claude' | 'codex' | 'cursor' | 'python'>('claude');

  const handleCopy = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const isStarting = status?.state === 'starting' || startMutation.isPending;
  const isStopping = stopMutation.isPending;
  const isActive = status?.state === 'active';
  const publicUrl = status?.url;

  return (
    <div className="x-page">
      {/* Header */}
      <div className="x-page-heading">
        <div>
          <div className="x-eyebrow">Cloudflare Edge Integration</div>
          <h1>{s.tunnelTitle}</h1>
          <p>{s.tunnelHelp}</p>
        </div>
        <span className="x-heading-icon">
          <Globe size={28} />
        </span>
      </div>

      {/* Main Status & Control Panel */}
      <div className="x-panel" style={{ padding: '24px', marginBottom: '24px' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '16px', marginBottom: '20px' }}>
          {/* Status Badge */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div
              style={{
                width: '14px',
                height: '14px',
                borderRadius: '50%',
                background: isActive
                  ? 'var(--x-green)'
                  : isStarting
                    ? '#d97706'
                    : status?.state === 'error'
                      ? 'var(--x-red)'
                      : 'var(--x-muted)',
                boxShadow: isActive ? '0 0 10px rgba(35, 124, 84, 0.6)' : 'none',
              }}
            />
            <h2 style={{ fontSize: '18px', fontWeight: 600, margin: 0 }}>
              {isActive
                ? s.stateActive
                : isStarting
                  ? s.stateStarting
                  : status?.state === 'error'
                    ? s.stateError
                    : s.stateStopped}
            </h2>
          </div>

          {/* Start / Stop Actions */}
          <div>
            {isActive ? (
              <button
                type="button"
                className="x-button"
                onClick={() => stopMutation.mutate()}
                disabled={!canManage || isStopping}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '8px',
                  borderColor: 'var(--x-red)',
                  color: 'var(--x-red)',
                }}
              >
                <Square size={14} />
                {isStopping ? s.stopping : s.stopTunnel}
              </button>
            ) : (
              <button
                type="button"
                className="x-button x-primary"
                onClick={() => startMutation.mutate(status?.port || 3001)}
                disabled={!canManage || isStarting}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}
              >
                <Play size={14} />
                {isStarting ? s.starting : s.startTunnel}
              </button>
            )}
          </div>
        </div>

        {/* Public Endpoint Banner */}
        {isActive && publicUrl ? (
          <div
            style={{
              padding: '18px',
              borderRadius: '10px',
              border: '1px solid var(--x-green)',
              background: 'var(--x-green-bg)',
              marginBottom: '20px',
            }}
          >
            <div style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', color: 'var(--x-green)', marginBottom: '6px' }}>
              {s.publicUrl}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
              <span
                style={{
                  fontFamily: 'monospace',
                  fontSize: '17px',
                  fontWeight: 600,
                  color: 'var(--x-text)',
                  wordBreak: 'break-all',
                }}
              >
                {publicUrl}
              </span>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  type="button"
                  className="x-button"
                  onClick={() => handleCopy(publicUrl, 'publicUrl')}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '6px 12px' }}
                >
                  {copiedKey === 'publicUrl' ? <Check size={14} /> : <Copy size={14} />}
                  {copiedKey === 'publicUrl' ? s.copied : s.copyUrl}
                </button>
                <a
                  href={`${publicUrl}/livez`}
                  target="_blank"
                  rel="noreferrer"
                  className="x-button"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '6px 12px' }}
                >
                  <ExternalLink size={14} />
                  {s.openInBrowser}
                </a>
              </div>
            </div>
          </div>
        ) : null}

        {/* Metrics Grid */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: '12px',
          }}
        >
          <div style={{ padding: '14px', borderRadius: '8px', background: 'var(--x-alt)', border: '1px solid var(--x-border)' }}>
            <span style={{ display: 'block', fontSize: '11px', color: 'var(--x-muted)', marginBottom: '4px' }}>
              {s.localPort}
            </span>
            <strong style={{ fontSize: '16px' }}>{status?.port ?? 3001}</strong>
          </div>

          <div style={{ padding: '14px', borderRadius: '8px', background: 'var(--x-alt)', border: '1px solid var(--x-border)' }}>
            <span style={{ display: 'block', fontSize: '11px', color: 'var(--x-muted)', marginBottom: '4px' }}>
              {s.uptime}
            </span>
            <strong style={{ fontSize: '16px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Clock size={14} style={{ color: 'var(--x-muted)' }} />
              {formatUptime(status?.uptimeSeconds ?? 0)}
            </strong>
          </div>

          <div style={{ padding: '14px', borderRadius: '8px', background: 'var(--x-alt)', border: '1px solid var(--x-border)' }}>
            <span style={{ display: 'block', fontSize: '11px', color: 'var(--x-muted)', marginBottom: '4px' }}>
              {s.reconnects}
            </span>
            <strong style={{ fontSize: '16px' }}>{status?.metrics?.reconnectCount ?? 0}</strong>
          </div>

          <div style={{ padding: '14px', borderRadius: '8px', background: 'var(--x-alt)', border: '1px solid var(--x-border)' }}>
            <span style={{ display: 'block', fontSize: '11px', color: 'var(--x-muted)', marginBottom: '4px' }}>
              {s.binaryStatus}
            </span>
            <strong
              style={{
                fontSize: '14px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                color: status?.cloudflaredInstalled ? 'var(--x-green)' : '#d97706',
              }}
            >
              {status?.cloudflaredInstalled ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
              {status?.cloudflaredInstalled ? s.binaryInstalled : s.binaryMissing}
            </strong>
          </div>
        </div>
      </div>

      {/* Binary Missing Installation Guide */}
      {status && !status.cloudflaredInstalled && (
        <div
          className="x-panel"
          style={{
            padding: '20px',
            marginBottom: '24px',
            border: '1px solid #d97706',
            background: 'var(--x-alt)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px', color: '#d97706' }}>
            <AlertTriangle size={20} />
            <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 600 }}>{s.binaryMissing}</h3>
          </div>
          <p style={{ margin: '0 0 12px', fontSize: '13px', color: 'var(--x-muted)' }}>
            {s.installInstructions}
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '10px' }}>
            <div style={{ padding: '10px 14px', background: 'var(--x-panel)', borderRadius: '6px', border: '1px solid var(--x-border)' }}>
              <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--x-muted)' }}>Windows (WinGet)</span>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '4px' }}>
                <code style={{ fontSize: '12px' }}>{s.installWindows}</code>
                <button
                  type="button"
                  className="x-button"
                  onClick={() => handleCopy(s.installWindows, 'win')}
                  style={{ padding: '4px 8px', fontSize: '11px' }}
                >
                  {copiedKey === 'win' ? <Check size={12} /> : <Copy size={12} />}
                </button>
              </div>
            </div>

            <div style={{ padding: '10px 14px', background: 'var(--x-panel)', borderRadius: '6px', border: '1px solid var(--x-border)' }}>
              <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--x-muted)' }}>macOS (Homebrew)</span>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '4px' }}>
                <code style={{ fontSize: '12px' }}>{s.installMac}</code>
                <button
                  type="button"
                  className="x-button"
                  onClick={() => handleCopy(s.installMac, 'mac')}
                  style={{ padding: '4px 8px', fontSize: '11px' }}
                >
                  {copiedKey === 'mac' ? <Check size={12} /> : <Copy size={12} />}
                </button>
              </div>
            </div>

            <div style={{ padding: '10px 14px', background: 'var(--x-panel)', borderRadius: '6px', border: '1px solid var(--x-border)' }}>
              <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--x-muted)' }}>Linux (Debian/Ubuntu)</span>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '4px' }}>
                <code style={{ fontSize: '12px' }}>{s.installLinux}</code>
                <button
                  type="button"
                  className="x-button"
                  onClick={() => handleCopy(s.installLinux, 'linux')}
                  style={{ padding: '4px 8px', fontSize: '11px' }}
                >
                  {copiedKey === 'linux' ? <Check size={12} /> : <Copy size={12} />}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Integration Code Snippets for Remote Agents */}
      <div className="x-panel" style={{ padding: '24px', marginBottom: '24px' }}>
        <h3 style={{ margin: '0 0 6px', fontSize: '16px', fontWeight: 600 }}>{s.remoteAgentTitle}</h3>
        <p style={{ margin: '0 0 16px', fontSize: '13px', color: 'var(--x-muted)' }}>{s.remoteAgentHelp}</p>

        {/* Snippet Tabs */}
        <div style={{ display: 'flex', gap: '8px', borderBottom: '1px solid var(--x-border)', paddingBottom: '10px', marginBottom: '16px', flexWrap: 'wrap' }}>
          <button
            type="button"
            className={`x-button ${activeSnippetTab === 'claude' ? 'x-primary' : ''}`}
            onClick={() => setActiveSnippetTab('claude')}
            style={{ fontSize: '12px', padding: '6px 12px' }}
          >
            {s.claudeCodeSnippet}
          </button>
          <button
            type="button"
            className={`x-button ${activeSnippetTab === 'codex' ? 'x-primary' : ''}`}
            onClick={() => setActiveSnippetTab('codex')}
            style={{ fontSize: '12px', padding: '6px 12px' }}
          >
            {s.codexSnippet}
          </button>
          <button
            type="button"
            className={`x-button ${activeSnippetTab === 'cursor' ? 'x-primary' : ''}`}
            onClick={() => setActiveSnippetTab('cursor')}
            style={{ fontSize: '12px', padding: '6px 12px' }}
          >
            {s.cursorSnippet}
          </button>
          <button
            type="button"
            className={`x-button ${activeSnippetTab === 'python' ? 'x-primary' : ''}`}
            onClick={() => setActiveSnippetTab('python')}
            style={{ fontSize: '12px', padding: '6px 12px' }}
          >
            {s.pythonSnippet}
          </button>
        </div>

        {/* Snippet Display Box */}
        {(() => {
          const effectiveUrl = publicUrl || 'https://your-tunnel.trycloudflare.com';
          let codeText = '';
          if (activeSnippetTab === 'claude') {
            codeText = `export ANTHROPIC_BASE_URL="${effectiveUrl}/x"\nexport ANTHROPIC_API_KEY="sk-xgw-your-key"\nclaude`;
          } else if (activeSnippetTab === 'codex') {
            codeText = `export OPENAI_BASE_URL="${effectiveUrl}/x/v1"\nexport OPENAI_API_KEY="sk-xgw-your-key"\ncodex`;
          } else if (activeSnippetTab === 'cursor') {
            codeText = `// In Cursor settings.json:\n{\n  "openai.baseURL": "${effectiveUrl}/x/v1",\n  "openai.apiKey": "sk-xgw-your-key"\n}`;
          } else {
            codeText = `from openai import OpenAI\n\nclient = OpenAI(\n    base_url="${effectiveUrl}/x/v1",\n    api_key="sk-xgw-your-key"\n)\nresponse = client.chat.completions.create(\n    model="auto",\n    messages=[{"role": "user", "content": "Hello via Quick Tunnel!"}]\n)`;
          }

          return (
            <div style={{ position: 'relative' }}>
              <pre
                style={{
                  margin: 0,
                  padding: '16px',
                  borderRadius: '8px',
                  background: 'var(--x-alt)',
                  border: '1px solid var(--x-border)',
                  color: 'var(--x-text)',
                  fontFamily: 'monospace',
                  fontSize: '13px',
                  lineHeight: 1.5,
                  overflowX: 'auto',
                }}
              >
                {codeText}
              </pre>
              <button
                type="button"
                className="x-button"
                onClick={() => handleCopy(codeText, 'snippet')}
                style={{
                  position: 'absolute',
                  top: '10px',
                  right: '10px',
                  fontSize: '12px',
                  padding: '5px 10px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
              >
                {copiedKey === 'snippet' ? <Check size={13} /> : <Copy size={13} />}
                {copiedKey === 'snippet' ? s.copied : s.copyUrl}
              </button>
            </div>
          );
        })()}
      </div>

      {/* Live Process Logs Viewer */}
      <div className="x-panel" style={{ padding: '24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px', flexWrap: 'wrap', gap: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Terminal size={18} style={{ color: 'var(--x-primary)' }} />
            <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 600 }}>{s.logsTitle}</h3>
            <span style={{ fontSize: '11px', color: 'var(--x-muted)' }}>({s.autoRefreshNote})</span>
          </div>
          <button
            type="button"
            className="x-button"
            onClick={() => refetchLogs()}
            disabled={logsFetching}
            style={{ fontSize: '12px', padding: '5px 10px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
          >
            <RefreshCw size={13} className={logsFetching ? 'x-spin' : ''} />
            {s.refreshLogs}
          </button>
        </div>

        <pre
          style={{
            margin: 0,
            padding: '16px',
            borderRadius: '8px',
            background: 'var(--x-alt)',
            border: '1px solid var(--x-border)',
            color: 'var(--x-text)',
            fontFamily: 'monospace',
            fontSize: '12px',
            lineHeight: 1.45,
            maxHeight: '320px',
            overflowY: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {logsData?.logs && logsData.logs.length > 0
            ? logsData.logs.join('\n')
            : s.noLogsYet}
        </pre>
      </div>
    </div>
  );
}
