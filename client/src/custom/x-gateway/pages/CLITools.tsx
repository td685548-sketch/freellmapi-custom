import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Terminal,
  ExternalLink,
  Copy,
  Check,
  Download,
  KeyRound,
  Globe,
  Plus,
  Play,
  RotateCw,
  Search,
  CheckCircle2,
  XCircle,
} from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { useUserSession } from '../../use-session';
import { useSessionRevision } from '../../session-state';
import { useToolsStrings } from '../tools-strings';
import { useToolsStatus, useTestToolConnection, type ToolTestResult } from '../tools-api';
import {
  CLI_TOOLS_CATALOG,
  formatBashExport,
  formatPowerShellExport,
  formatCmdExport,
  formatEnvFile,
} from '../tools-config';

type XGatewayKey = {
  id: number;
  userId: number;
  name: string;
  keyPrefix: string;
  rpmLimit: number;
  revoked: boolean;
  createdAt: string;
  lastUsedAt: string | null;
};

type CreatedKeyResponse = {
  id: number;
  key: string;
  keyPrefix: string;
  name: string;
  createdAt: string;
};

type ShellTab = 'bash' | 'powershell' | 'cmd' | 'config' | 'env';

export default function CLITools() {
  const s = useToolsStrings();
  const queryClient = useQueryClient();
  const revision = useSessionRevision();
  const session = useUserSession();

  const [selectedToolId, setSelectedToolId] = useState<string>('claude');
  const [selectedKeyId, setSelectedKeyId] = useState<string>('auto');
  const [newKeyMaterial, setNewKeyMaterial] = useState<string | null>(null);
  const [urlMode, setUrlMode] = useState<'origin' | 'custom'>('origin');
  const [customUrlInput, setCustomUrlInput] = useState<string>(
    typeof window !== 'undefined' ? `${window.location.origin}/x/v1` : 'https://your-domain.onrender.com/x/v1'
  );
  const [shellTab, setShellTab] = useState<ShellTab>('bash');
  const [categoryFilter, setCategoryFilter] = useState<'all' | 'cli' | 'ide' | 'agent'>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [copiedSnippet, setCopiedSnippet] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [testResults, setTestResults] = useState<Record<string, ToolTestResult>>({});

  const canEdit = session.hasPermission('edit_x_settings') || session.hasPermission('use_x_gateway');

  // Load client keys
  const keysQuery = useQuery({
    queryKey: ['x-gateway-keys', revision],
    queryFn: ({ signal }) => apiFetch<{ keys: XGatewayKey[] }>('/api/x-gateway/keys', { signal }),
    retry: false,
  });

  // Tools status probe
  const toolsStatus = useToolsStatus(revision);
  const testMutation = useTestToolConnection();

  // Mint new key mutation
  const createKeyMutation = useMutation({
    mutationFn: () =>
      apiFetch<CreatedKeyResponse>('/api/x-gateway/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'CLI Tool Quick Key' }),
      }),
    onSuccess: (data) => {
      setNewKeyMaterial(data.key);
      setSelectedKeyId(String(data.id));
      void queryClient.invalidateQueries({ queryKey: ['x-gateway-keys'] });
    },
  });

  // Resolve active Base URL
  const activeBaseUrl = useMemo(() => {
    if (urlMode === 'custom') return customUrlInput.trim() || 'https://your-domain.onrender.com/x/v1';
    if (typeof window !== 'undefined') {
      return `${window.location.origin}/x/v1`;
    }
    return 'http://localhost:3001/x/v1';
  }, [urlMode, customUrlInput]);

  // Resolve active API Key
  const activeApiKey = useMemo(() => {
    if (newKeyMaterial) return newKeyMaterial;
    const keys = keysQuery.data?.keys ?? [];
    if (selectedKeyId !== 'auto') {
      const found = keys.find((k) => String(k.id) === selectedKeyId);
      if (found) return `${found.keyPrefix}...[full-key]`;
    }
    if (keys.length > 0) {
      return `${keys[0].keyPrefix}...[full-key]`;
    }
    return 'sk-xgw-your-token-here';
  }, [newKeyMaterial, keysQuery.data?.keys, selectedKeyId]);

  // Filter tools
  const filteredTools = useMemo(() => {
    return CLI_TOOLS_CATALOG.filter((tool) => {
      if (categoryFilter !== 'all' && tool.category !== categoryFilter) return false;
      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase();
      return (
        tool.name.toLowerCase().includes(q) ||
        tool.id.toLowerCase().includes(q) ||
        tool.tagline.toLowerCase().includes(q) ||
        tool.protocol.toLowerCase().includes(q)
      );
    });
  }, [categoryFilter, searchQuery]);

  const selectedTool = useMemo(
    () => CLI_TOOLS_CATALOG.find((t) => t.id === selectedToolId) ?? CLI_TOOLS_CATALOG[0],
    [selectedToolId]
  );

  // Format code based on active tab
  const formattedCode = useMemo(() => {
    if (!selectedTool) return '';
    switch (shellTab) {
      case 'bash':
        return formatBashExport(selectedTool, activeBaseUrl, activeApiKey);
      case 'powershell':
        return formatPowerShellExport(selectedTool, activeBaseUrl, activeApiKey);
      case 'cmd':
        return formatCmdExport(selectedTool, activeBaseUrl, activeApiKey);
      case 'env':
        return formatEnvFile(selectedTool, activeBaseUrl, activeApiKey);
      case 'config':
        return selectedTool.configFile
          ? selectedTool.configFile.generate({ baseUrl: activeBaseUrl, apiKey: activeApiKey })
          : formatEnvFile(selectedTool, activeBaseUrl, activeApiKey);
      default:
        return '';
    }
  }, [selectedTool, shellTab, activeBaseUrl, activeApiKey]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(formattedCode);
      setCopiedSnippet(true);
      setTimeout(() => setCopiedSnippet(false), 2000);
    } catch {
      // fallback
    }
  };

  const handleDownloadConfig = () => {
    if (!selectedTool?.configFile) return;
    const blob = new Blob([formattedCode], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = selectedTool.configFile.filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    setDownloaded(true);
    setTimeout(() => setDownloaded(false), 2000);
  };

  const handleTestConnection = async (toolId: string) => {
    try {
      const res = await testMutation.mutateAsync(toolId);
      setTestResults((prev) => ({ ...prev, [toolId]: res }));
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : 'Network error';
      setTestResults((prev) => ({
        ...prev,
        [toolId]: { ok: false, toolId, error: errorMsg },
      }));
    }
  };

  return (
    <div className="x-panel-container" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Header */}
      <section className="x-panel">
        <div className="x-section-heading">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 8,
                background: 'var(--x-primary-bg, rgba(59, 130, 246, 0.1))',
                color: 'var(--x-primary, #3b82f6)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Terminal size={20} />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <h1 style={{ fontSize: '1.25rem', fontWeight: 600, margin: 0 }}>{s.title}</h1>
                {toolsStatus.data && (
                  <span
                    style={{
                      fontSize: '0.75rem',
                      padding: '2px 8px',
                      borderRadius: 12,
                      background: 'rgba(16, 185, 129, 0.1)',
                      color: '#10b981',
                      fontWeight: 500,
                    }}
                  >
                    {toolsStatus.data.usableAccounts} {toolsStatus.data.usableAccounts === 1 ? 'account' : 'accounts'} active
                  </span>
                )}
              </div>
              <p style={{ margin: '4px 0 0', fontSize: '0.875rem', color: 'var(--x-ink-subtle)' }}>
                {s.subtitle}
              </p>
            </div>
          </div>
        </div>

        {/* Configuration Bar */}
        <div
          style={{
            marginTop: 16,
            padding: 16,
            borderRadius: 10,
            background: 'var(--x-surface-subtle)',
            border: '1px solid var(--x-border)',
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: 16,
          }}
        >
          {/* Active Key Selector */}
          <div>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: '0.8rem',
                fontWeight: 600,
                color: 'var(--x-ink)',
                marginBottom: 6,
              }}
            >
              <KeyRound size={14} />
              {s.selectKey}
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <select
                value={selectedKeyId}
                onChange={(e) => {
                  setSelectedKeyId(e.target.value);
                  setNewKeyMaterial(null);
                }}
                style={{
                  flex: 1,
                  padding: '7px 10px',
                  borderRadius: 6,
                  border: '1px solid var(--x-border)',
                  background: 'var(--x-surface)',
                  color: 'var(--x-ink)',
                  fontSize: '0.85rem',
                }}
              >
                {newKeyMaterial && <option value="new">Newly Created Key (Full Key Injected)</option>}
                <option value="auto">
                  {keysQuery.data?.keys?.[0]
                    ? `${keysQuery.data.keys[0].name} (${keysQuery.data.keys[0].keyPrefix}...)`
                    : s.noKeySelected}
                </option>
                {keysQuery.data?.keys.map((k) => (
                  <option key={k.id} value={String(k.id)}>
                    {k.name} ({k.keyPrefix}...)
                  </option>
                ))}
              </select>
              {canEdit && (
                <button
                  type="button"
                  className="x-button x-small"
                  onClick={() => createKeyMutation.mutate()}
                  disabled={createKeyMutation.isPending}
                  title={s.createKeyBtn}
                >
                  <Plus size={14} />
                  {createKeyMutation.isPending ? s.creatingKey : s.createKeyBtn}
                </button>
              )}
            </div>
            {newKeyMaterial && (
              <p style={{ margin: '6px 0 0', fontSize: '0.75rem', color: 'var(--x-green, #10b981)' }}>
                Full key active in snippets. Keep this token safe!
              </p>
            )}
          </div>

          {/* Base URL Selector */}
          <div>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: '0.8rem',
                fontWeight: 600,
                color: 'var(--x-ink)',
                marginBottom: 6,
              }}
            >
              <Globe size={14} />
              {s.serverUrl}
            </label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <select
                value={urlMode}
                onChange={(e) => setUrlMode(e.target.value as 'origin' | 'custom')}
                style={{
                  padding: '7px 10px',
                  borderRadius: 6,
                  border: '1px solid var(--x-border)',
                  background: 'var(--x-surface)',
                  color: 'var(--x-ink)',
                  fontSize: '0.85rem',
                }}
              >
                <option value="origin">{s.originUrl}</option>
                <option value="custom">{s.customUrl}</option>
              </select>
              {urlMode === 'custom' ? (
                <input
                  type="text"
                  value={customUrlInput}
                  onChange={(e) => setCustomUrlInput(e.target.value)}
                  placeholder="https://your-domain.com/x/v1"
                  style={{
                    flex: 1,
                    padding: '7px 10px',
                    borderRadius: 6,
                    border: '1px solid var(--x-border)',
                    background: 'var(--x-surface)',
                    color: 'var(--x-ink)',
                    fontSize: '0.85rem',
                  }}
                />
              ) : (
                <div
                  style={{
                    flex: 1,
                    padding: '7px 10px',
                    borderRadius: 6,
                    background: 'var(--x-surface)',
                    border: '1px solid var(--x-border)',
                    color: 'var(--x-ink-subtle)',
                    fontSize: '0.8rem',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={activeBaseUrl}
                >
                  {activeBaseUrl}
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Main Layout: Tool List on left, Config Drawer on right */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 20 }}>
        {/* Left Side: Tool Directory */}
        <section className="x-panel" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Filters & Search */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ position: 'relative' }}>
              <Search
                size={16}
                style={{
                  position: 'absolute',
                  left: 10,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  color: 'var(--x-ink-subtle)',
                }}
              />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={s.searchPlaceholder}
                style={{
                  width: '100%',
                  padding: '8px 12px 8px 34px',
                  borderRadius: 8,
                  border: '1px solid var(--x-border)',
                  background: 'var(--x-surface)',
                  color: 'var(--x-ink)',
                  fontSize: '0.85rem',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            {/* Category tabs */}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {(
                [
                  { id: 'all', label: s.categoryAll },
                  { id: 'cli', label: s.categoryCli },
                  { id: 'ide', label: s.categoryIde },
                  { id: 'agent', label: s.categoryAgent },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setCategoryFilter(tab.id)}
                  style={{
                    padding: '5px 12px',
                    borderRadius: 20,
                    fontSize: '0.75rem',
                    fontWeight: 500,
                    cursor: 'pointer',
                    border: '1px solid',
                    borderColor: categoryFilter === tab.id ? 'var(--x-primary)' : 'var(--x-border)',
                    background:
                      categoryFilter === tab.id
                        ? 'var(--x-primary-bg, rgba(59, 130, 246, 0.1))'
                        : 'var(--x-surface)',
                    color: categoryFilter === tab.id ? 'var(--x-primary, #3b82f6)' : 'var(--x-ink)',
                    transition: 'all 0.15s ease',
                  }}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          {/* Cards List */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 600, overflowY: 'auto' }}>
            {filteredTools.length === 0 ? (
              <p style={{ textAlign: 'center', color: 'var(--x-ink-subtle)', margin: '30px 0', fontSize: '0.85rem' }}>
                {s.noToolsFound}
              </p>
            ) : (
              filteredTools.map((tool) => {
                const isSelected = tool.id === selectedToolId;
                const testResult = testResults[tool.id];

                return (
                  <div
                    key={tool.id}
                    onClick={() => setSelectedToolId(tool.id)}
                    style={{
                      padding: 12,
                      borderRadius: 10,
                      border: '1px solid',
                      borderColor: isSelected ? 'var(--x-primary, #3b82f6)' : 'var(--x-border)',
                      background: isSelected
                        ? 'var(--x-primary-bg, rgba(59, 130, 246, 0.05))'
                        : 'var(--x-surface)',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 12,
                      transition: 'border-color 0.15s ease, background 0.15s ease',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                      <img
                        src={tool.image}
                        alt={tool.name}
                        onError={(e) => {
                          (e.target as HTMLElement).style.display = 'none';
                        }}
                        style={{
                          width: 32,
                          height: 32,
                          borderRadius: 8,
                          objectFit: 'contain',
                          background: '#ffffff',
                          padding: 2,
                          border: '1px solid var(--x-border)',
                          flexShrink: 0,
                        }}
                      />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--x-ink)' }}>
                            {tool.name}
                          </span>
                          <span
                            style={{
                              fontSize: '0.65rem',
                              padding: '2px 6px',
                              borderRadius: 4,
                              background: 'var(--x-surface-subtle)',
                              color: 'var(--x-ink-subtle)',
                              border: '1px solid var(--x-border)',
                            }}
                          >
                            {tool.badge}
                          </span>
                        </div>
                        <p
                          style={{
                            margin: '2px 0 0',
                            fontSize: '0.75rem',
                            color: 'var(--x-ink-subtle)',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {tool.tagline}
                        </p>
                      </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                      {testResult && (
                        <span
                          title={testResult.ok ? testResult.message : testResult.error}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 4,
                            fontSize: '0.7rem',
                            padding: '2px 6px',
                            borderRadius: 4,
                            background: testResult.ok ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                            color: testResult.ok ? '#10b981' : '#ef4444',
                          }}
                        >
                          {testResult.ok ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                          {testResult.ok ? `${testResult.latencyMs}ms` : 'Err'}
                        </span>
                      )}
                      <button
                        type="button"
                        className="x-button x-small"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleTestConnection(tool.id);
                        }}
                        disabled={testMutation.isPending && testMutation.variables === tool.id}
                        title={s.testConnection}
                        style={{ padding: '4px 8px' }}
                      >
                        {testMutation.isPending && testMutation.variables === tool.id ? (
                          <RotateCw size={12} className="x-spin" />
                        ) : (
                          <Play size={12} />
                        )}
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>

        {/* Right Side: Setup Instructions & Snippets */}
        {selectedTool && (
          <section className="x-panel" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Selected Tool Header */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                borderBottom: '1px solid var(--x-border)',
                paddingBottom: 12,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <img
                  src={selectedTool.image}
                  alt={selectedTool.name}
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 8,
                    objectFit: 'contain',
                    background: '#ffffff',
                    padding: 2,
                    border: '1px solid var(--x-border)',
                  }}
                />
                <div>
                  <h2 style={{ fontSize: '1.1rem', fontWeight: 600, margin: 0, color: 'var(--x-ink)' }}>
                    {selectedTool.name}
                  </h2>
                  <p style={{ margin: '2px 0 0', fontSize: '0.75rem', color: 'var(--x-ink-subtle)' }}>
                    Protocol: <strong>{selectedTool.protocol}</strong>
                  </p>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  className="x-button x-small"
                  onClick={() => handleTestConnection(selectedTool.id)}
                  disabled={testMutation.isPending}
                >
                  {testMutation.isPending ? <RotateCw size={14} className="x-spin" /> : <Play size={14} />}
                  {s.testConnection}
                </button>
                <a
                  href={selectedTool.docsUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="x-button x-small"
                  style={{ textDecoration: 'none' }}
                >
                  <ExternalLink size={14} />
                  {s.viewDocs}
                </a>
              </div>
            </div>

            {/* Test result banner if available */}
            {testResults[selectedTool.id] && (
              <div
                style={{
                  padding: '10px 14px',
                  borderRadius: 8,
                  fontSize: '0.8rem',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  background: testResults[selectedTool.id].ok
                    ? 'rgba(16, 185, 129, 0.1)'
                    : 'rgba(239, 68, 68, 0.1)',
                  color: testResults[selectedTool.id].ok ? '#10b981' : '#ef4444',
                  border: `1px solid ${testResults[selectedTool.id].ok ? '#10b98140' : '#ef444440'}`,
                }}
              >
                {testResults[selectedTool.id].ok ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
                <span>
                  {testResults[selectedTool.id].ok
                    ? s.testOk.replace('{latency}', String(testResults[selectedTool.id].latencyMs))
                    : s.testFailed.replace('{error}', String(testResults[selectedTool.id].error))}
                </span>
              </div>
            )}

            {/* Step-by-step guidance */}
            {selectedTool.steps && selectedTool.steps.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <h3 style={{ fontSize: '0.85rem', fontWeight: 600, margin: 0, color: 'var(--x-ink)' }}>
                  {s.setupInstructions}
                </h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {selectedTool.steps.map((step, idx) => (
                    <div
                      key={idx}
                      style={{
                        padding: '8px 12px',
                        borderRadius: 8,
                        background: 'var(--x-surface-subtle)',
                        border: '1px solid var(--x-border)',
                        fontSize: '0.8rem',
                      }}
                    >
                      <div style={{ fontWeight: 600, color: 'var(--x-ink)', marginBottom: 2 }}>
                        {idx + 1}. {step.title}
                      </div>
                      <div style={{ color: 'var(--x-ink-subtle)' }}>
                        {step.desc.replace('{{baseUrl}}', activeBaseUrl).replace('{{apiKey}}', activeApiKey)}
                      </div>
                      {step.codeSnippet && (
                        <pre
                          style={{
                            margin: '6px 0 0',
                            padding: '6px 10px',
                            background: 'var(--x-surface)',
                            borderRadius: 6,
                            fontSize: '0.75rem',
                            border: '1px solid var(--x-border)',
                            fontFamily: 'monospace',
                          }}
                        >
                          <code>
                            {step.codeSnippet
                              .replace('{{baseUrl}}', activeBaseUrl)
                              .replace('{{apiKey}}', activeApiKey)}
                          </code>
                        </pre>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Code Generator Shell Tabs */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: 8,
                }}
              >
                <div style={{ display: 'flex', gap: 4, background: 'var(--x-surface-subtle)', padding: 3, borderRadius: 8 }}>
                  <button
                    type="button"
                    onClick={() => setShellTab('bash')}
                    style={{
                      padding: '4px 10px',
                      borderRadius: 6,
                      fontSize: '0.75rem',
                      border: 'none',
                      cursor: 'pointer',
                      background: shellTab === 'bash' ? 'var(--x-surface)' : 'transparent',
                      color: shellTab === 'bash' ? 'var(--x-ink)' : 'var(--x-ink-subtle)',
                      fontWeight: shellTab === 'bash' ? 600 : 400,
                    }}
                  >
                    {s.tabBash}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShellTab('powershell')}
                    style={{
                      padding: '4px 10px',
                      borderRadius: 6,
                      fontSize: '0.75rem',
                      border: 'none',
                      cursor: 'pointer',
                      background: shellTab === 'powershell' ? 'var(--x-surface)' : 'transparent',
                      color: shellTab === 'powershell' ? 'var(--x-ink)' : 'var(--x-ink-subtle)',
                      fontWeight: shellTab === 'powershell' ? 600 : 400,
                    }}
                  >
                    {s.tabPowerShell}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShellTab('cmd')}
                    style={{
                      padding: '4px 10px',
                      borderRadius: 6,
                      fontSize: '0.75rem',
                      border: 'none',
                      cursor: 'pointer',
                      background: shellTab === 'cmd' ? 'var(--x-surface)' : 'transparent',
                      color: shellTab === 'cmd' ? 'var(--x-ink)' : 'var(--x-ink-subtle)',
                      fontWeight: shellTab === 'cmd' ? 600 : 400,
                    }}
                  >
                    {s.tabCmd}
                  </button>
                  {selectedTool.configFile && (
                    <button
                      type="button"
                      onClick={() => setShellTab('config')}
                      style={{
                        padding: '4px 10px',
                        borderRadius: 6,
                        fontSize: '0.75rem',
                        border: 'none',
                        cursor: 'pointer',
                        background: shellTab === 'config' ? 'var(--x-surface)' : 'transparent',
                        color: shellTab === 'config' ? 'var(--x-ink)' : 'var(--x-ink-subtle)',
                        fontWeight: shellTab === 'config' ? 600 : 400,
                      }}
                    >
                      {selectedTool.configFile.filename}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setShellTab('env')}
                    style={{
                      padding: '4px 10px',
                      borderRadius: 6,
                      fontSize: '0.75rem',
                      border: 'none',
                      cursor: 'pointer',
                      background: shellTab === 'env' ? 'var(--x-surface)' : 'transparent',
                      color: shellTab === 'env' ? 'var(--x-ink)' : 'var(--x-ink-subtle)',
                      fontWeight: shellTab === 'env' ? 600 : 400,
                    }}
                  >
                    {s.tabEnv}
                  </button>
                </div>

                <div style={{ display: 'flex', gap: 6 }}>
                  {selectedTool.configFile && shellTab === 'config' && (
                    <button
                      type="button"
                      className="x-button x-small"
                      onClick={handleDownloadConfig}
                      title={s.downloadConfig}
                    >
                      <Download size={13} />
                      {downloaded ? s.downloaded : s.downloadConfig}
                    </button>
                  )}
                  <button
                    type="button"
                    className="x-button x-small x-primary"
                    onClick={handleCopy}
                  >
                    {copiedSnippet ? <Check size={13} /> : <Copy size={13} />}
                    {copiedSnippet ? s.copied : s.copyCommand}
                  </button>
                </div>
              </div>

              {/* Code display */}
              <pre
                style={{
                  margin: 0,
                  padding: 14,
                  borderRadius: 8,
                  background: 'var(--x-surface-subtle)',
                  border: '1px solid var(--x-border)',
                  color: 'var(--x-ink)',
                  fontSize: '0.8rem',
                  fontFamily: 'Consolas, Monaco, "Courier New", monospace',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  overflowX: 'auto',
                }}
              >
                <code>{formattedCode}</code>
              </pre>
              <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--x-ink-subtle)' }}>
                {s.quickExportTip}
              </p>
            </div>

            {/* Model Aliases Section */}
            {selectedTool.aliases && selectedTool.aliases.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
                <h3 style={{ fontSize: '0.85rem', fontWeight: 600, margin: 0, color: 'var(--x-ink)' }}>
                  {s.modelAliases}
                </h3>
                <div
                  style={{
                    borderRadius: 8,
                    border: '1px solid var(--x-border)',
                    overflow: 'hidden',
                    fontSize: '0.75rem',
                  }}
                >
                  <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
                    <thead>
                      <tr style={{ background: 'var(--x-surface-subtle)', borderBottom: '1px solid var(--x-border)' }}>
                        <th style={{ padding: '8px 12px' }}>{s.aliasCol}</th>
                        <th style={{ padding: '8px 12px' }}>{s.targetCol}</th>
                        <th style={{ padding: '8px 12px' }}>Description</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedTool.aliases.map((al, i) => (
                        <tr
                          key={i}
                          style={{
                            borderBottom: i === selectedTool.aliases!.length - 1 ? 'none' : '1px solid var(--x-border)',
                          }}
                        >
                          <td style={{ padding: '8px 12px', fontFamily: 'monospace', fontWeight: 600 }}>
                            {al.alias}
                          </td>
                          <td style={{ padding: '8px 12px', fontFamily: 'monospace', color: 'var(--x-primary)' }}>
                            {al.targetModel}
                          </td>
                          <td style={{ padding: '8px 12px', color: 'var(--x-ink-subtle)' }}>
                            {al.desc ?? '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
