import { useCallback, useEffect, useRef, useState } from 'react';
import { useCustomT } from '../../i18n/use-custom-t';
import { useAdministrativeAccess } from '../../use-administrative-access';
import { useUserSession } from '../../use-session';
import { ApprovalQueue } from '../components/ApprovalQueue';
import { InternalOriginsEditor } from '../components/InternalOriginsEditor';
import { McpCallLog } from '../components/McpCallLog';
import { ScopeToolBindings } from '../components/ScopeToolBindings';
import { ToolReviewTable } from '../components/ToolReviewTable';
import {
  MCP_LIMITS,
  createMcpServer,
  deleteMcpServer,
  fetchMcpServerTools,
  fetchMcpServers,
  syncMcpServer,
  testMcpServer,
  updateMcpServer,
  type McpAuthKind,
  type McpServerStatus,
  type McpServerView,
  type McpToolView,
} from '../mcp-api';
import {
  MCP_ACTION_FORBIDDEN,
  MCP_ADD_SERVER,
  MCP_AUTH_BEARER,
  MCP_AUTH_HEADER,
  MCP_AUTH_NONE,
  MCP_CANCEL,
  MCP_DELETE_SERVER,
  MCP_DISABLE_SERVER,
  MCP_EDIT_SERVER,
  MCP_ENABLE_SERVER,
  MCP_FIELD_AUTH_KIND,
  MCP_FIELD_HEADER_NAME,
  MCP_FIELD_MAX_CONCURRENCY,
  MCP_FIELD_MAX_RESULT_BYTES,
  MCP_FIELD_NAME,
  MCP_FIELD_SECRET,
  MCP_FIELD_SLUG,
  MCP_FIELD_SLUG_HINT,
  MCP_FIELD_TIMEOUT_MS,
  MCP_FIELD_URL,
  MCP_FORCE_DELETE,
  MCP_IN_USE_DESC,
  MCP_IN_USE_TITLE,
  MCP_LOADING_SERVERS,
  MCP_LOAD_SERVERS_ERROR,
  MCP_NO_PERMISSION,
  MCP_NO_SERVERS,
  MCP_PAGE_SUBTITLE,
  MCP_PAGE_TITLE,
  MCP_PILLAR_DISABLED,
  MCP_REVISION_CONFLICT,
  MCP_SAVE_SERVER,
  MCP_SAVING,
  MCP_SECRET_CLEAR,
  MCP_SECRET_NONE,
  MCP_SECRET_SET,
  MCP_SECRET_WRITE_ONLY_CREATE,
  MCP_SECRET_WRITE_ONLY_EDIT,
  MCP_STATUS_ERROR,
  MCP_STATUS_OK,
  MCP_STATUS_PAUSED,
  MCP_STATUS_UNKNOWN,
  MCP_SYNCING_SERVER,
  MCP_SYNC_DONE,
  MCP_SYNC_SERVER,
  MCP_TAB_APPROVALS,
  MCP_TAB_BINDINGS,
  MCP_TAB_CALLS,
  MCP_TAB_ORIGINS,
  MCP_TAB_SERVERS,
  MCP_TESTING_SERVER,
  MCP_TEST_FAILED,
  MCP_TEST_OK,
  MCP_TEST_SERVER,
  MCP_UNSAFE_URL,
} from '../mcp-strings';

type McpTab = 'servers' | 'bindings' | 'approvals' | 'calls' | 'origins';

const SERVER_STATUS_LABEL: Record<McpServerStatus, string> = {
  ok: MCP_STATUS_OK,
  error: MCP_STATUS_ERROR,
  paused: MCP_STATUS_PAUSED,
  unknown: MCP_STATUS_UNKNOWN,
};

interface ServerFormState {
  mode: 'create' | 'edit';
  editingId: number | null;
  revision: number;
  hasSecret: boolean;
  slug: string;
  name: string;
  url: string;
  authKind: McpAuthKind;
  authHeaderName: string;
  secret: string;
  clearSecret: boolean;
  timeoutMs: number;
  maxResultBytes: number;
  maxConcurrency: number;
}

function emptyCreateForm(): ServerFormState {
  return {
    mode: 'create',
    editingId: null,
    revision: 1,
    hasSecret: false,
    slug: '',
    name: '',
    url: '',
    authKind: 'none',
    authHeaderName: '',
    secret: '',
    clearSecret: false,
    timeoutMs: MCP_LIMITS.defaultTimeoutMs,
    maxResultBytes: MCP_LIMITS.defaultMaxResultBytes,
    maxConcurrency: MCP_LIMITS.defaultMaxConcurrency,
  };
}

function editFormFromServer(s: McpServerView): ServerFormState {
  return {
    mode: 'edit',
    editingId: s.id,
    revision: s.revision,
    hasSecret: s.hasSecret,
    slug: s.slug,
    name: s.name,
    url: s.url,
    authKind: s.authKind,
    authHeaderName: s.authHeaderName ?? '',
    secret: '',
    clearSecret: false,
    timeoutMs: s.timeoutMs,
    maxResultBytes: s.maxResultBytes,
    maxConcurrency: s.maxConcurrency,
  };
}

export function McpServers() {
  const tc = useCustomT();
  const { can } = useAdministrativeAccess();
  const { isPrimary } = useUserSession();

  const canViewServers = isPrimary || can('view_mcp_servers') || can('edit_mcp_servers') || can('review_mcp_tools');
  const canEditServers = isPrimary || can('edit_mcp_servers');
  const canReviewTools = isPrimary || can('review_mcp_tools');
  const canApprove = isPrimary || can('approve_ai_actions');

  const hasAnyMcpAccess = canViewServers || canApprove || isPrimary;
  const defaultTab: McpTab = canViewServers || isPrimary ? 'servers' : 'approvals';

  const [tab, setTab] = useState<McpTab>(defaultTab);
  const [servers, setServers] = useState<McpServerView[]>([]);
  const [serversLoaded, setServersLoaded] = useState(false);
  const [serversError, setServersError] = useState<string | null>(null);
  const loadingServers = canViewServers && !serversLoaded;

  const [selectedServerId, setSelectedServerId] = useState<number | null>(null);
  const [tools, setTools] = useState<McpToolView[]>([]);
  const [loadedToolsServerId, setLoadedToolsServerId] = useState<number | null>(null);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const loadingTools = canViewServers && selectedServerId !== null && loadedToolsServerId !== selectedServerId;

  const [form, setForm] = useState<ServerFormState | null>(null);
  const [savingForm, setSavingForm] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [busyServerId, setBusyServerId] = useState<number | null>(null);
  const [busyAction, setBusyAction] = useState<'test' | 'sync' | 'toggle' | 'delete' | null>(null);
  const [banner, setBanner] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const [inUseConfirmId, setInUseConfirmId] = useState<number | null>(null);

  const serversAbortRef = useRef<AbortController | null>(null);
  const toolsAbortRef = useRef<AbortController | null>(null);
  const actionAbortRef = useRef<AbortController | null>(null);
  const toolsEpochRef = useRef(0);
  const mountedRef = useRef(true);

  const loadServers = useCallback(async () => {
    if (!canViewServers) return;
    serversAbortRef.current?.abort();
    const ac = new AbortController();
    serversAbortRef.current = ac;
    try {
      const res = await fetchMcpServers(ac.signal);
      if (!mountedRef.current || ac.signal.aborted) return;
      setServersError(null);
      setServers(res.servers);
      setSelectedServerId((prev) => {
        if (prev && res.servers.some((s) => s.id === prev)) return prev;
        return res.servers[0]?.id ?? null;
      });
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      if ((err as { name?: string })?.name === 'AbortError') return;
      setServersError((err as Error)?.message ?? tc(MCP_LOAD_SERVERS_ERROR));
    } finally {
      if (mountedRef.current) setServersLoaded(true);
    }
  }, [canViewServers, tc]);

  const loadTools = useCallback(async (serverId: number | null) => {
    toolsEpochRef.current += 1;
    const callEpoch = toolsEpochRef.current;
    toolsAbortRef.current?.abort();
    if (!serverId || !canViewServers) {
      return;
    }
    const ac = new AbortController();
    toolsAbortRef.current = ac;
    try {
      const res = await fetchMcpServerTools(serverId, ac.signal);
      if (!mountedRef.current || callEpoch !== toolsEpochRef.current || ac.signal.aborted) return;
      setToolsError(null);
      setTools(res.tools);
    } catch (err: unknown) {
      if (!mountedRef.current || callEpoch !== toolsEpochRef.current) return;
      if ((err as { name?: string })?.name === 'AbortError') return;
      setToolsError((err as Error)?.message ?? 'Failed to load tools');
    } finally {
      if (mountedRef.current && callEpoch === toolsEpochRef.current) {
        setLoadedToolsServerId(serverId);
      }
    }
  }, [canViewServers]);

  useEffect(() => {
    mountedRef.current = true;
    if (canViewServers) {
      serversAbortRef.current?.abort();
      const ac = new AbortController();
      serversAbortRef.current = ac;
      fetchMcpServers(ac.signal)
        .then((res) => {
          if (!mountedRef.current || ac.signal.aborted) return;
          setServersError(null);
          setServers(res.servers);
          setSelectedServerId((prev) => {
            if (prev && res.servers.some((s) => s.id === prev)) return prev;
            return res.servers[0]?.id ?? null;
          });
        })
        .catch((err: unknown) => {
          if (!mountedRef.current) return;
          if ((err as { name?: string })?.name === 'AbortError') return;
          setServersError((err as Error)?.message ?? tc(MCP_LOAD_SERVERS_ERROR));
        })
        .finally(() => {
          if (mountedRef.current) setServersLoaded(true);
        });
    }
    return () => {
      mountedRef.current = false;
      serversAbortRef.current?.abort();
      toolsAbortRef.current?.abort();
      actionAbortRef.current?.abort();
    };
  }, [canViewServers, tc]);

  useEffect(() => {
    toolsEpochRef.current += 1;
    const callEpoch = toolsEpochRef.current;
    toolsAbortRef.current?.abort();
    if (!selectedServerId || !canViewServers) {
      return;
    }
    const ac = new AbortController();
    toolsAbortRef.current = ac;
    fetchMcpServerTools(selectedServerId, ac.signal)
      .then((res) => {
        if (!mountedRef.current || callEpoch !== toolsEpochRef.current || ac.signal.aborted) return;
        setToolsError(null);
        setTools(res.tools);
      })
      .catch((err: unknown) => {
        if (!mountedRef.current || callEpoch !== toolsEpochRef.current) return;
        if ((err as { name?: string })?.name === 'AbortError') return;
        setToolsError((err as Error)?.message ?? 'Failed to load tools');
      })
      .finally(() => {
        if (mountedRef.current && callEpoch === toolsEpochRef.current) {
          setLoadedToolsServerId(selectedServerId);
        }
      });
  }, [selectedServerId, canViewServers]);

  if (!hasAnyMcpAccess) {
    return (
      <div className="p-6" data-testid="mcp-no-permission">
        <p className="text-sm text-muted-foreground">{tc(MCP_NO_PERMISSION)}</p>
      </div>
    );
  }

  const selectedServer = servers.find((s) => s.id === selectedServerId) ?? null;

  function formatApiError(err: unknown): string {
    const status = (err as { status?: number })?.status;
    const code = (err as { code?: string })?.code;
    if (status === 403) return tc(MCP_ACTION_FORBIDDEN);
    if (status === 409 && code === 'pillar_disabled') return tc(MCP_PILLAR_DISABLED);
    if (status === 409 && code === 'revision_conflict') return tc(MCP_REVISION_CONFLICT);
    if (status === 422 && code === 'unsafe_url') return tc(MCP_UNSAFE_URL);
    return (err as Error)?.message ?? 'Request failed';
  }

  async function handleSaveForm(e: React.FormEvent) {
    e.preventDefault();
    if (!form || !canEditServers || savingForm) return;
    actionAbortRef.current?.abort();
    const ac = new AbortController();
    actionAbortRef.current = ac;
    setSavingForm(true);
    setFormError(null);

    try {
      if (form.mode === 'create') {
        const res = await createMcpServer(
          {
            slug: form.slug.trim(),
            name: form.name.trim(),
            url: form.url.trim(),
            authKind: form.authKind,
            authHeaderName: form.authKind === 'header' ? form.authHeaderName.trim() : null,
            secret: form.secret.trim() ? form.secret : undefined,
            timeoutMs: form.timeoutMs,
            maxResultBytes: form.maxResultBytes,
            maxConcurrency: form.maxConcurrency,
          },
          ac.signal,
        );
        if (!mountedRef.current) return;
        setServers((prev) => [...prev, res.server]);
        setSelectedServerId(res.server.id);
      } else if (form.editingId !== null) {
        const patch: Parameters<typeof updateMcpServer>[1] = {
          revision: form.revision,
          slug: form.slug.trim(),
          name: form.name.trim(),
          url: form.url.trim(),
          authKind: form.authKind,
          authHeaderName: form.authKind === 'header' ? form.authHeaderName.trim() : null,
          timeoutMs: form.timeoutMs,
          maxResultBytes: form.maxResultBytes,
          maxConcurrency: form.maxConcurrency,
        };
        if (form.clearSecret) {
          patch.secret = null;
        } else if (form.secret.trim().length > 0) {
          patch.secret = form.secret;
        }
        const res = await updateMcpServer(form.editingId, patch, ac.signal);
        if (!mountedRef.current) return;
        setServers((prev) => prev.map((s) => (s.id === res.server.id ? res.server : s)));
      }
      setForm(null);
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      if ((err as { name?: string })?.name === 'AbortError') return;
      const status = (err as { status?: number })?.status;
      const code = (err as { code?: string })?.code;
      if (status === 409 && code === 'revision_conflict') {
        await loadServers();
      }
      setFormError(formatApiError(err));
    } finally {
      if (mountedRef.current) setSavingForm(false);
    }
  }

  async function handleToggleEnabled(server: McpServerView) {
    if (!canEditServers || busyServerId !== null) return;
    actionAbortRef.current?.abort();
    const ac = new AbortController();
    actionAbortRef.current = ac;
    setBusyServerId(server.id);
    setBusyAction('toggle');
    setBanner(null);
    try {
      const res = await updateMcpServer(
        server.id,
        { revision: server.revision, enabled: !server.enabled },
        ac.signal,
      );
      if (!mountedRef.current) return;
      setServers((prev) => prev.map((s) => (s.id === server.id ? res.server : s)));
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      if ((err as { name?: string })?.name === 'AbortError') return;
      if ((err as { status?: number; code?: string })?.status === 409) {
        await loadServers();
      }
      setBanner({ kind: 'error', text: formatApiError(err) });
    } finally {
      if (mountedRef.current) {
        setBusyServerId(null);
        setBusyAction(null);
      }
    }
  }

  async function handleTest(server: McpServerView) {
    if (!canEditServers || busyServerId !== null) return;
    actionAbortRef.current?.abort();
    const ac = new AbortController();
    actionAbortRef.current = ac;
    setBusyServerId(server.id);
    setBusyAction('test');
    setBanner(null);
    try {
      const res = await testMcpServer(server.id, ac.signal);
      if (!mountedRef.current) return;
      if (res.ok) {
        const msg = tc(MCP_TEST_OK)
          .replace('{count}', String(res.toolCount ?? 0))
          .replace('{version}', res.protocolVersion ?? 'unknown');
        setBanner({ kind: 'info', text: msg });
      } else {
        setBanner({
          kind: 'error',
          text: tc(MCP_TEST_FAILED).replace('{error}', res.error ?? 'Unknown error'),
        });
      }
      await loadServers();
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      if ((err as { name?: string })?.name === 'AbortError') return;
      setBanner({ kind: 'error', text: formatApiError(err) });
    } finally {
      if (mountedRef.current) {
        setBusyServerId(null);
        setBusyAction(null);
      }
    }
  }

  async function handleSync(server: McpServerView) {
    if (!canEditServers || busyServerId !== null) return;
    actionAbortRef.current?.abort();
    const ac = new AbortController();
    actionAbortRef.current = ac;
    setBusyServerId(server.id);
    setBusyAction('sync');
    setBanner(null);
    try {
      const res = await syncMcpServer(server.id, ac.signal);
      if (!mountedRef.current) return;
      const msg = tc(MCP_SYNC_DONE)
        .replace('{added}', String(res.added))
        .replace('{changed}', String(res.changed))
        .replace('{missing}', String(res.missing))
        .replace('{unchanged}', String(res.unchanged));
      setBanner({ kind: 'info', text: msg });
      if (selectedServerId === server.id) {
        await loadTools(server.id);
      }
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      if ((err as { name?: string })?.name === 'AbortError') return;
      setBanner({ kind: 'error', text: formatApiError(err) });
    } finally {
      if (mountedRef.current) {
        setBusyServerId(null);
        setBusyAction(null);
      }
    }
  }

  async function handleDelete(serverId: number, force = false) {
    if (!canEditServers || busyServerId !== null) return;
    actionAbortRef.current?.abort();
    const ac = new AbortController();
    actionAbortRef.current = ac;
    setBusyServerId(serverId);
    setBusyAction('delete');
    setBanner(null);
    try {
      await deleteMcpServer(serverId, force ? { force: true } : undefined, ac.signal);
      if (!mountedRef.current) return;
      setInUseConfirmId(null);
      setServers((prev) => prev.filter((s) => s.id !== serverId));
      if (selectedServerId === serverId) {
        setSelectedServerId(null);
      }
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      if ((err as { name?: string })?.name === 'AbortError') return;
      const status = (err as { status?: number })?.status;
      const code = (err as { code?: string })?.code;
      if (status === 409 && code === 'in_use') {
        setInUseConfirmId(serverId);
      } else {
        setBanner({ kind: 'error', text: formatApiError(err) });
      }
    } finally {
      if (mountedRef.current) {
        setBusyServerId(null);
        setBusyAction(null);
      }
    }
  }

  const tabs: Array<{ id: McpTab; label: string; visible: boolean }> = [
    { id: 'servers', label: tc(MCP_TAB_SERVERS), visible: canViewServers },
    { id: 'bindings', label: tc(MCP_TAB_BINDINGS), visible: canViewServers },
    { id: 'approvals', label: tc(MCP_TAB_APPROVALS), visible: canApprove || canViewServers },
    { id: 'calls', label: tc(MCP_TAB_CALLS), visible: canViewServers },
    { id: 'origins', label: tc(MCP_TAB_ORIGINS), visible: isPrimary },
  ];

  return (
    <div className="p-6 space-y-6" data-testid="mcp-page">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">{tc(MCP_PAGE_TITLE)}</h2>
          <p className="text-sm text-muted-foreground mt-0.5">{tc(MCP_PAGE_SUBTITLE)}</p>
        </div>
        {canEditServers && tab === 'servers' && (
          <button
            type="button"
            data-testid="mcp-add-server"
            onClick={() => {
              setFormError(null);
              setForm(emptyCreateForm());
            }}
            className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground"
          >
            {tc(MCP_ADD_SERVER)}
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap gap-2 border-b pb-2" role="tablist">
        {tabs
          .filter((t) => t.visible)
          .map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              data-testid={`mcp-tab-${t.id}`}
              onClick={() => setTab(t.id)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                tab === t.id
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted'
              }`}
            >
              {t.label}
            </button>
          ))}
      </div>

      {banner && (
        <div
          role={banner.kind === 'error' ? 'alert' : 'status'}
          className={`rounded border px-3 py-2 text-xs ${
            banner.kind === 'error'
              ? 'border-destructive/40 bg-destructive/10 text-destructive'
              : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
          }`}
        >
          {banner.text}
        </div>
      )}

      {inUseConfirmId !== null && (
        <div className="rounded border border-amber-500/50 bg-amber-500/10 p-3 space-y-2 text-xs" role="alert">
          <div className="font-medium">{tc(MCP_IN_USE_TITLE)}</div>
          <p className="text-muted-foreground">{tc(MCP_IN_USE_DESC)}</p>
          <div className="flex gap-2">
            <button
              type="button"
              data-testid={`mcp-force-delete-${inUseConfirmId}`}
              onClick={() => handleDelete(inUseConfirmId, true)}
              className="rounded bg-destructive px-2.5 py-1 text-xs font-medium text-destructive-foreground"
            >
              {tc(MCP_FORCE_DELETE)}
            </button>
            <button
              type="button"
              onClick={() => setInUseConfirmId(null)}
              className="rounded border px-2.5 py-1 text-xs hover:bg-muted"
            >
              {tc(MCP_CANCEL)}
            </button>
          </div>
        </div>
      )}

      {/* Server create/edit dialog */}
      {form && (
        <form
          onSubmit={handleSaveForm}
          className="rounded-lg border bg-card p-4 space-y-3"
          data-testid="mcp-server-form"
        >
          <h3 className="text-base font-medium">
            {form.mode === 'create' ? tc(MCP_ADD_SERVER) : tc(MCP_EDIT_SERVER)}
          </h3>

          {formError && (
            <div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
              {formError}
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs">
              <span className="font-medium block">{tc(MCP_FIELD_SLUG)}</span>
              <input
                type="text"
                required
                data-testid="mcp-input-slug"
                value={form.slug}
                onChange={(e) => setForm({ ...form, slug: e.target.value })}
                className="w-full rounded border bg-background px-2 py-1.5 text-sm font-mono"
              />
              <span className="text-[11px] text-muted-foreground block">{tc(MCP_FIELD_SLUG_HINT)}</span>
            </label>

            <label className="space-y-1 text-xs">
              <span className="font-medium block">{tc(MCP_FIELD_NAME)}</span>
              <input
                type="text"
                required
                data-testid="mcp-input-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full rounded border bg-background px-2 py-1.5 text-sm"
              />
            </label>

            <label className="space-y-1 text-xs sm:col-span-2">
              <span className="font-medium block">{tc(MCP_FIELD_URL)}</span>
              <input
                type="url"
                required
                data-testid="mcp-input-url"
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
                className="w-full rounded border bg-background px-2 py-1.5 text-sm font-mono"
              />
            </label>

            <label className="space-y-1 text-xs">
              <span className="font-medium block">{tc(MCP_FIELD_AUTH_KIND)}</span>
              <select
                data-testid="mcp-input-auth-kind"
                value={form.authKind}
                onChange={(e) => setForm({ ...form, authKind: e.target.value as McpAuthKind })}
                className="w-full rounded border bg-background px-2 py-1.5 text-sm"
              >
                <option value="none">{tc(MCP_AUTH_NONE)}</option>
                <option value="bearer">{tc(MCP_AUTH_BEARER)}</option>
                <option value="header">{tc(MCP_AUTH_HEADER)}</option>
              </select>
            </label>

            {form.authKind === 'header' && (
              <label className="space-y-1 text-xs">
                <span className="font-medium block">{tc(MCP_FIELD_HEADER_NAME)}</span>
                <input
                  type="text"
                  required
                  data-testid="mcp-input-header-name"
                  value={form.authHeaderName}
                  onChange={(e) => setForm({ ...form, authHeaderName: e.target.value })}
                  className="w-full rounded border bg-background px-2 py-1.5 text-sm font-mono"
                />
              </label>
            )}

            <label className="space-y-1 text-xs sm:col-span-2">
              <span className="font-medium block">{tc(MCP_FIELD_SECRET)}</span>
              <input
                type="password"
                autoComplete="new-password"
                data-testid="mcp-input-secret"
                value={form.secret}
                disabled={form.clearSecret}
                onChange={(e) => setForm({ ...form, secret: e.target.value })}
                className="w-full rounded border bg-background px-2 py-1.5 text-sm"
              />
              <span className="text-[11px] text-muted-foreground block">
                {form.mode === 'create'
                  ? tc(MCP_SECRET_WRITE_ONLY_CREATE)
                  : tc(MCP_SECRET_WRITE_ONLY_EDIT)}
              </span>
            </label>

            {form.mode === 'edit' && form.hasSecret && (
              <label className="flex items-center gap-2 text-xs sm:col-span-2">
                <input
                  type="checkbox"
                  data-testid="mcp-clear-secret"
                  checked={form.clearSecret}
                  onChange={(e) => setForm({ ...form, clearSecret: e.target.checked, secret: '' })}
                />
                <span>{tc(MCP_SECRET_CLEAR)}</span>
              </label>
            )}

            <label className="space-y-1 text-xs">
              <span className="font-medium block">{tc(MCP_FIELD_TIMEOUT_MS)}</span>
              <input
                type="number"
                min={MCP_LIMITS.minTimeoutMs}
                max={MCP_LIMITS.maxTimeoutMs}
                value={form.timeoutMs}
                onChange={(e) => setForm({ ...form, timeoutMs: Number(e.target.value) })}
                className="w-full rounded border bg-background px-2 py-1.5 text-sm"
              />
            </label>

            <label className="space-y-1 text-xs">
              <span className="font-medium block">{tc(MCP_FIELD_MAX_RESULT_BYTES)}</span>
              <input
                type="number"
                min={MCP_LIMITS.minResultBytes}
                max={MCP_LIMITS.maxResultBytes}
                value={form.maxResultBytes}
                onChange={(e) => setForm({ ...form, maxResultBytes: Number(e.target.value) })}
                className="w-full rounded border bg-background px-2 py-1.5 text-sm"
              />
            </label>

            <label className="space-y-1 text-xs">
              <span className="font-medium block">{tc(MCP_FIELD_MAX_CONCURRENCY)}</span>
              <input
                type="number"
                min={MCP_LIMITS.minConcurrency}
                max={MCP_LIMITS.maxConcurrency}
                value={form.maxConcurrency}
                onChange={(e) => setForm({ ...form, maxConcurrency: Number(e.target.value) })}
                className="w-full rounded border bg-background px-2 py-1.5 text-sm"
              />
            </label>
          </div>

          <div className="flex gap-2 pt-2">
            <button
              type="submit"
              data-testid="mcp-save-server"
              disabled={savingForm}
              className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              {savingForm ? tc(MCP_SAVING) : tc(MCP_SAVE_SERVER)}
            </button>
            <button
              type="button"
              onClick={() => setForm(null)}
              className="rounded border px-3 py-1.5 text-xs hover:bg-muted"
            >
              {tc(MCP_CANCEL)}
            </button>
          </div>
        </form>
      )}

      {/* Tab content */}
      {tab === 'servers' && canViewServers && (
        <div className="space-y-6">
          <section className="rounded-lg border bg-card p-4 space-y-3">
            {serversError && (
              <div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
                {serversError}
              </div>
            )}
            {loadingServers ? (
              <p className="text-sm text-muted-foreground">{tc(MCP_LOADING_SERVERS)}</p>
            ) : servers.length === 0 ? (
              <p className="text-sm text-muted-foreground">{tc(MCP_NO_SERVERS)}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="py-2 pr-3">{tc(MCP_FIELD_SLUG)}</th>
                      <th className="py-2 pr-3">{tc(MCP_FIELD_URL)}</th>
                      <th className="py-2 pr-3">{tc(MCP_FIELD_AUTH_KIND)}</th>
                      <th className="py-2 pr-3">Status</th>
                      <th className="py-2 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {servers.map((srv) => {
                      const isSelected = srv.id === selectedServerId;
                      const isBusy = busyServerId === srv.id;
                      return (
                        <tr
                          key={srv.id}
                          className={`border-b last:border-b-0 ${isSelected ? 'bg-muted/30' : ''}`}
                        >
                          <td className="py-2 pr-3">
                            <button
                              type="button"
                              onClick={() => setSelectedServerId(srv.id)}
                              className="text-left font-medium hover:underline"
                            >
                              {srv.slug}
                            </button>
                            <div className="text-xs text-muted-foreground">{srv.name}</div>
                          </td>
                          <td className="py-2 pr-3 font-mono text-xs">{srv.url}</td>
                          <td className="py-2 pr-3 text-xs">
                            <div>{srv.authKind}</div>
                            <div className="text-muted-foreground">
                              {srv.hasSecret ? tc(MCP_SECRET_SET) : tc(MCP_SECRET_NONE)}
                            </div>
                          </td>
                          <td className="py-2 pr-3 text-xs">
                            <span className="rounded bg-muted px-2 py-0.5">
                              {tc(SERVER_STATUS_LABEL[srv.status])}
                            </span>
                            {srv.lastError && (
                              <div className="text-[11px] text-destructive mt-0.5">{srv.lastError}</div>
                            )}
                          </td>
                          <td className="py-2 text-right whitespace-nowrap space-x-1">
                            <button
                              type="button"
                              data-testid={`mcp-toggle-server-${srv.id}`}
                              disabled={!canEditServers || isBusy}
                              onClick={() => handleToggleEnabled(srv)}
                              className="rounded border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
                            >
                              {srv.enabled ? tc(MCP_DISABLE_SERVER) : tc(MCP_ENABLE_SERVER)}
                            </button>
                            <button
                              type="button"
                              data-testid={`mcp-test-server-${srv.id}`}
                              disabled={!canEditServers || isBusy}
                              onClick={() => handleTest(srv)}
                              className="rounded border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
                            >
                              {isBusy && busyAction === 'test' ? tc(MCP_TESTING_SERVER) : tc(MCP_TEST_SERVER)}
                            </button>
                            <button
                              type="button"
                              data-testid={`mcp-sync-server-${srv.id}`}
                              disabled={!canEditServers || isBusy}
                              onClick={() => handleSync(srv)}
                              className="rounded border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
                            >
                              {isBusy && busyAction === 'sync' ? tc(MCP_SYNCING_SERVER) : tc(MCP_SYNC_SERVER)}
                            </button>
                            <button
                              type="button"
                              data-testid={`mcp-edit-server-${srv.id}`}
                              disabled={!canEditServers || isBusy}
                              onClick={() => {
                                setFormError(null);
                                setForm(editFormFromServer(srv));
                              }}
                              className="rounded border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
                            >
                              {tc(MCP_EDIT_SERVER)}
                            </button>
                            <button
                              type="button"
                              data-testid={`mcp-delete-server-${srv.id}`}
                              disabled={!canEditServers || isBusy}
                              onClick={() => handleDelete(srv.id)}
                              className="rounded border px-2 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
                            >
                              {tc(MCP_DELETE_SERVER)}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <ToolReviewTable
            key={selectedServer?.id ?? 'none'}
            server={selectedServer}
            tools={tools}
            loading={loadingTools}
            error={toolsError}
            canReview={canReviewTools}
            onReviewed={(updated) => {
              setTools((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
            }}
          />
        </div>
      )}

      {tab === 'bindings' && canViewServers && (
        <ScopeToolBindings canEdit={canReviewTools} />
      )}

      {tab === 'approvals' && (canApprove || canViewServers) && (
        <ApprovalQueue canApprove={canApprove} />
      )}

      {tab === 'calls' && canViewServers && (
        <McpCallLog servers={servers} />
      )}

      {tab === 'origins' && isPrimary && (
        <InternalOriginsEditor isPrimary={isPrimary} />
      )}
    </div>
  );
}
