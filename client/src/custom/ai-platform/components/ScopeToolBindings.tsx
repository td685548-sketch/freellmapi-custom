import { useEffect, useRef, useState } from 'react';
import { useCustomT } from '../../i18n/use-custom-t';
import {
  MCP_LIMITS,
  fetchMcpBindings,
  fetchMcpServers,
  fetchMcpServerTools,
  fetchProfileOptions,
  fetchSupportTenantOptions,
  putMcpBindings,
  type McpBindingView,
  type McpToolView,
  type ProfileOption,
  type Scope,
  type ScopeKind,
  type SupportTenantOption,
} from '../mcp-api';
import {
  MCP_ACTION_FORBIDDEN,
  MCP_AI_TOOLS_ENABLED,
  MCP_BINDINGS_HEADING,
  MCP_BINDINGS_SAVED,
  MCP_CATALOG_LOAD_ERROR,
  MCP_MAX_ROUNDS,
  MCP_NO_ALLOWED_TOOLS,
  MCP_NON_ALLOWED_TOOLS,
  MCP_SAVE_BINDINGS,
  MCP_SAVING,
  MCP_SCOPE_AGENT,
  MCP_SCOPE_ID_PLACEHOLDER,
  MCP_SCOPE_KIND,
  MCP_SCOPE_PROFILE,
  MCP_SCOPE_SUPPORT_TENANT,
  MCP_SCOPE_TARGET,
  MCP_SCOPE_UNAVAILABLE,
  MCP_SERVER_DISABLED_BADGE,
  MCP_STATE_ALLOWED,
  MCP_STATE_BLOCKED,
  MCP_STATE_MISSING,
  MCP_STATE_PENDING,
  MCP_SUPPORT_RUNTIME_NOTE,
  MCP_TOOL_REQUIRES_REVIEW_PERM,
  MCP_UNAVAILABLE_BOUND_TOOLS,
} from '../mcp-strings';

interface ScopeToolBindingsProps {
  canEdit: boolean;
}

interface CatalogToolEntry {
  tool: McpToolView;
  serverEnabled: boolean;
}

const TOOL_STATE_LABEL: Record<McpToolView['state'], string> = {
  allowed: MCP_STATE_ALLOWED,
  pending: MCP_STATE_PENDING,
  blocked: MCP_STATE_BLOCKED,
  missing: MCP_STATE_MISSING,
};

export function ScopeToolBindings({ canEdit }: ScopeToolBindingsProps) {
  const tc = useCustomT();
  const [scopeKind, setScopeKind] = useState<ScopeKind>('profile');
  const [scopeId, setScopeId] = useState<string>('');
  const [profiles, setProfiles] = useState<ProfileOption[]>([]);
  const [tenants, setTenants] = useState<SupportTenantOption[]>([]);

  const [catalog, setCatalog] = useState<CatalogToolEntry[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [binding, setBinding] = useState<McpBindingView | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [maxRounds, setMaxRounds] = useState<number>(MCP_LIMITS.defaultMaxRounds);
  const [selectedToolIds, setSelectedToolIds] = useState<number[]>([]);

  const [loadedScopeKey, setLoadedScopeKey] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);
  const activeScopeKey = scopeKind !== 'agent' && scopeId.trim() ? `${scopeKind}:${scopeId.trim()}` : null;
  const loading = activeScopeKey !== null && loadedScopeKey !== activeScopeKey;

  const loadAbortRef = useRef<AbortController | null>(null);
  const catalogAbortRef = useRef<AbortController | null>(null);
  const saveAbortRef = useRef<AbortController | null>(null);
  const epochRef = useRef(0);
  const catalogEpochRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const ac = new AbortController();
    catalogAbortRef.current?.abort();
    catalogAbortRef.current = ac;
    catalogEpochRef.current += 1;
    const myCatalogEpoch = catalogEpochRef.current;

    Promise.all([
      fetchProfileOptions(ac.signal).catch(() => []),
      fetchSupportTenantOptions(ac.signal).catch(() => []),
    ]).then(([pList, tList]) => {
      if (!mountedRef.current || ac.signal.aborted) return;
      setProfiles(pList);
      setTenants(tList);
      setScopeId((prev) => prev || (pList[0] ? String(pList[0].id) : ''));
    });

    fetchMcpServers(ac.signal)
      .then(async (srvRes) => {
        if (!mountedRef.current || ac.signal.aborted || myCatalogEpoch !== catalogEpochRef.current) return;
        const servers = srvRes.servers ?? [];
        const perServer = await Promise.all(
          servers.map(async (srv) => {
            const toolsRes = await fetchMcpServerTools(srv.id, ac.signal);
            const serverEnabled = srv.enabled !== false;
            return (toolsRes.tools ?? []).map((tool) => ({ tool, serverEnabled }));
          }),
        );
        if (!mountedRef.current || ac.signal.aborted || myCatalogEpoch !== catalogEpochRef.current) return;
        setCatalog(perServer.flat());
        setCatalogError(null);
      })
      .catch((err: unknown) => {
        if (!mountedRef.current || ac.signal.aborted || myCatalogEpoch !== catalogEpochRef.current) return;
        if ((err as { name?: string })?.name === 'AbortError') return;
        const status = (err as { status?: number })?.status;
        setCatalogError(
          status === 403
            ? tc(MCP_ACTION_FORBIDDEN)
            : (err as Error)?.message ?? tc(MCP_CATALOG_LOAD_ERROR),
        );
      });

    return () => {
      mountedRef.current = false;
      ac.abort();
      loadAbortRef.current?.abort();
      catalogAbortRef.current?.abort();
      saveAbortRef.current?.abort();
    };
  }, [tc]);

  // Reset scopeId when switching scopeKind
  function handleKindChange(nextKind: ScopeKind) {
    epochRef.current += 1;
    loadAbortRef.current?.abort();
    saveAbortRef.current?.abort();
    setScopeKind(nextKind);
    setBinding(null);
    setError(null);
    setSavedNotice(false);
    if (nextKind === 'profile') {
      setScopeId(profiles[0] ? String(profiles[0].id) : '');
    } else if (nextKind === 'support_tenant') {
      setScopeId(tenants[0] ? tenants[0].id : '');
    } else {
      setScopeId('');
    }
  }

  useEffect(() => {
    epochRef.current += 1;
    const callEpoch = epochRef.current;
    loadAbortRef.current?.abort();

    if (scopeKind === 'agent' || !scopeId.trim()) {
      return;
    }

    const ac = new AbortController();
    loadAbortRef.current = ac;
    const currentKey = `${scopeKind}:${scopeId.trim()}`;

    const scope: Scope = { kind: scopeKind, id: scopeId.trim() };
    fetchMcpBindings(scope, ac.signal)
      .then((res) => {
        if (!mountedRef.current || callEpoch !== epochRef.current || ac.signal.aborted) return;
        setError(null);
        setSavedNotice(false);
        setBinding(res.binding);
        setEnabled(res.binding.aiToolsEnabled);
        setMaxRounds(res.binding.maxRounds ?? MCP_LIMITS.defaultMaxRounds);
        setSelectedToolIds(res.binding.toolIds);
      })
      .catch((err: unknown) => {
        if (!mountedRef.current || callEpoch !== epochRef.current) return;
        if ((err as { name?: string })?.name === 'AbortError') return;
        const code = (err as { code?: string })?.code;
        setError(
          code === 'scope_unavailable'
            ? tc(MCP_SCOPE_UNAVAILABLE)
            : (err as Error)?.message ?? 'Failed to load bindings',
        );
      })
      .finally(() => {
        if (mountedRef.current && callEpoch === epochRef.current) {
          setLoadedScopeKey(currentKey);
        }
      });
  }, [scopeKind, scopeId, tc]);

  async function handleSave() {
    if (!canEdit || scopeKind === 'agent' || !scopeId.trim() || saving) return;
    saveAbortRef.current?.abort();
    const ac = new AbortController();
    saveAbortRef.current = ac;
    const callEpoch = epochRef.current;

    setSaving(true);
    setError(null);
    setSavedNotice(false);
    try {
      const res = await putMcpBindings(
        { kind: scopeKind, id: scopeId.trim() },
        {
          toolIds: selectedToolIds,
          enabled,
          maxRounds: Number.isFinite(maxRounds) ? maxRounds : MCP_LIMITS.defaultMaxRounds,
        },
        ac.signal,
      );
      if (!mountedRef.current || callEpoch !== epochRef.current) return;
      setBinding(res.binding);
      setEnabled(res.binding.aiToolsEnabled);
      setMaxRounds(res.binding.maxRounds ?? MCP_LIMITS.defaultMaxRounds);
      setSelectedToolIds(res.binding.toolIds);
      setSavedNotice(true);
    } catch (err: unknown) {
      if (!mountedRef.current || callEpoch !== epochRef.current) return;
      if ((err as { name?: string })?.name === 'AbortError') return;
      const status = (err as { status?: number })?.status;
      setError(
        status === 403
          ? tc(MCP_ACTION_FORBIDDEN)
          : (err as Error)?.message ?? 'Failed to save bindings',
      );
    } finally {
      if (mountedRef.current && callEpoch === epochRef.current) {
        setSaving(false);
      }
    }
  }

  function toggleTool(toolId: number) {
    setSelectedToolIds((prev) =>
      prev.includes(toolId) ? prev.filter((id) => id !== toolId) : [...prev, toolId],
    );
  }

  const targetOptions =
    scopeKind === 'profile'
      ? profiles.map((p) => ({ id: String(p.id), label: `${p.name} (#${p.id})` }))
      : scopeKind === 'support_tenant'
        ? tenants.map((t) => ({ id: t.id, label: `${t.name} (${t.id})` }))
        : [];

  return (
    <section className="rounded-lg border bg-card p-4 space-y-4" data-testid="mcp-scope-bindings">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-medium">{tc(MCP_BINDINGS_HEADING)}</h3>
        {!canEdit && (
          <span className="text-xs text-muted-foreground">{tc(MCP_TOOL_REQUIRES_REVIEW_PERM)}</span>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs">
          <span className="font-medium block">{tc(MCP_SCOPE_KIND)}</span>
          <select
            data-testid="mcp-binding-scope-kind"
            value={scopeKind}
            onChange={(e) => handleKindChange(e.target.value as ScopeKind)}
            className="w-full rounded border bg-background px-2 py-1.5 text-sm"
          >
            <option value="profile">{tc(MCP_SCOPE_PROFILE)}</option>
            <option value="support_tenant">{tc(MCP_SCOPE_SUPPORT_TENANT)}</option>
            <option value="agent">{tc(MCP_SCOPE_AGENT)}</option>
          </select>
        </label>

        {scopeKind !== 'agent' && (
          <label className="space-y-1 text-xs">
            <span className="font-medium block">{tc(MCP_SCOPE_TARGET)}</span>
            {targetOptions.length > 0 ? (
              <select
                data-testid="mcp-binding-target"
                value={scopeId}
                onChange={(e) => setScopeId(e.target.value)}
                className="w-full rounded border bg-background px-2 py-1.5 text-sm"
              >
                {targetOptions.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                data-testid="mcp-binding-target"
                value={scopeId}
                placeholder={tc(MCP_SCOPE_ID_PLACEHOLDER)}
                onChange={(e) => setScopeId(e.target.value)}
                className="w-full rounded border bg-background px-2 py-1.5 text-sm"
              />
            )}
          </label>
        )}
      </div>

      {scopeKind === 'agent' && (
        <div className="rounded border bg-muted/40 px-3 py-2 text-xs text-muted-foreground" role="status">
          {tc(MCP_SCOPE_UNAVAILABLE)}
        </div>
      )}

      {scopeKind === 'support_tenant' && (
        <div className="rounded border bg-muted/40 px-3 py-2 text-xs text-muted-foreground" role="note">
          {tc(MCP_SUPPORT_RUNTIME_NOTE)}
        </div>
      )}

      {error && (
        <div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
          {error}
        </div>
      )}

      {catalogError && (
        <div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
          {catalogError}
        </div>
      )}

      {savedNotice && (
        <div className="rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300" role="status">
          {tc(MCP_BINDINGS_SAVED)}
        </div>
      )}

      {scopeKind !== 'agent' && scopeId.trim() && (
        loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : binding && (() => {
          const catalogById = new Map<number, CatalogToolEntry>();
          for (const entry of catalog) {
            catalogById.set(entry.tool.id, entry);
          }

          const selectableTools: McpToolView[] = [];
          const nonAllowedTools: CatalogToolEntry[] = [];
          for (const entry of catalog) {
            if (entry.tool.state === 'allowed' && entry.serverEnabled) {
              selectableTools.push(entry.tool);
            } else {
              nonAllowedTools.push(entry);
            }
          }
          const selectableIds = new Set(selectableTools.map((t) => t.id));

          // Preserve any bound tools missing from selectableTools (e.g., pending/blocked/missing or disabled server)
          const unusableBoundMap = new Map<number, { tool: McpToolView; serverEnabled: boolean }>();
          for (const bt of binding.tools) {
            if (!selectableIds.has(bt.id)) {
              const cat = catalogById.get(bt.id);
              unusableBoundMap.set(bt.id, { tool: cat?.tool ?? bt, serverEnabled: cat?.serverEnabled ?? true });
            }
          }
          for (const id of selectedToolIds) {
            if (!selectableIds.has(id) && !unusableBoundMap.has(id)) {
              const cat = catalogById.get(id);
              if (cat) {
                unusableBoundMap.set(id, cat);
              }
            }
          }
          const unusableBound = Array.from(unusableBoundMap.values());
          const remainingNonAllowed = nonAllowedTools.filter((e) => !unusableBoundMap.has(e.tool.id));

          return (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-6">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    data-testid="mcp-binding-enabled"
                    checked={enabled}
                    disabled={!canEdit || saving}
                    onChange={(e) => setEnabled(e.target.checked)}
                  />
                  <span>{tc(MCP_AI_TOOLS_ENABLED)}</span>
                </label>

                <label className="flex items-center gap-2 text-sm">
                  <span>{tc(MCP_MAX_ROUNDS)}</span>
                  <input
                    type="number"
                    data-testid="mcp-binding-max-rounds"
                    min={MCP_LIMITS.minRounds}
                    max={MCP_LIMITS.maxRounds}
                    value={maxRounds}
                    disabled={!canEdit || saving}
                    onChange={(e) => setMaxRounds(Number(e.target.value))}
                    className="w-20 rounded border bg-background px-2 py-1 text-sm"
                  />
                </label>
              </div>

              {selectableTools.length === 0 ? (
                <p className="text-xs text-muted-foreground">{tc(MCP_NO_ALLOWED_TOOLS)}</p>
              ) : (
                <div className="space-y-1.5" data-testid="mcp-binding-available-list">
                  {selectableTools.map((tool) => (
                    <label key={tool.id} className="flex items-start gap-2 rounded border p-2 text-sm">
                      <input
                        type="checkbox"
                        data-testid={`mcp-binding-tool-${tool.id}`}
                        checked={selectedToolIds.includes(tool.id)}
                        disabled={!canEdit || saving}
                        onChange={() => toggleTool(tool.id)}
                      />
                      <div className="flex-1">
                        <div className="font-mono text-xs font-medium">{tool.exposedName}</div>
                        {tool.description && (
                          <div className="text-xs text-muted-foreground">{tool.description}</div>
                        )}
                      </div>
                    </label>
                  ))}
                </div>
              )}

              {unusableBound.length > 0 && (
                <div className="space-y-1.5" data-testid="mcp-binding-unusable-bound">
                  <div className="text-xs font-medium text-amber-700 dark:text-amber-400">
                    {tc(MCP_UNAVAILABLE_BOUND_TOOLS)}
                  </div>
                  {unusableBound.map(({ tool, serverEnabled }) => (
                    <label key={tool.id} className="flex items-start gap-2 rounded border border-amber-500/40 bg-amber-500/5 p-2 text-sm">
                      <input
                        type="checkbox"
                        data-testid={`mcp-binding-tool-${tool.id}`}
                        checked={selectedToolIds.includes(tool.id)}
                        disabled={!canEdit || saving}
                        onChange={() => toggleTool(tool.id)}
                      />
                      <div className="flex-1">
                        <div className="flex flex-wrap items-center gap-2 font-mono text-xs font-medium">
                          <span>{tool.exposedName}</span>
                          <span className="rounded bg-amber-500/20 px-1.5 py-0.5 font-sans text-[11px]">
                            {tc(TOOL_STATE_LABEL[tool.state])}
                          </span>
                          {!serverEnabled && (
                            <span className="rounded bg-muted px-1.5 py-0.5 font-sans text-[11px]">
                              {tc(MCP_SERVER_DISABLED_BADGE)}
                            </span>
                          )}
                        </div>
                        {tool.description && (
                          <div className="text-xs text-muted-foreground">{tool.description}</div>
                        )}
                      </div>
                    </label>
                  ))}
                </div>
              )}

              {remainingNonAllowed.length > 0 && (
                <div className="space-y-1.5" data-testid="mcp-binding-non-allowed">
                  <div className="text-xs font-medium text-muted-foreground">
                    {tc(MCP_NON_ALLOWED_TOOLS)}
                  </div>
                  {remainingNonAllowed.map(({ tool, serverEnabled }) => (
                    <div key={tool.id} className="flex items-start gap-2 rounded border bg-muted/30 p-2 text-sm opacity-75">
                      <input
                        type="checkbox"
                        data-testid={`mcp-binding-disabled-tool-${tool.id}`}
                        checked={false}
                        disabled
                        readOnly
                      />
                      <div className="flex-1">
                        <div className="flex flex-wrap items-center gap-2 font-mono text-xs font-medium">
                          <span>{tool.exposedName}</span>
                          <span className="rounded bg-muted px-1.5 py-0.5 font-sans text-[11px]">
                            {tc(TOOL_STATE_LABEL[tool.state])}
                          </span>
                          {!serverEnabled && (
                            <span className="rounded bg-muted px-1.5 py-0.5 font-sans text-[11px]">
                              {tc(MCP_SERVER_DISABLED_BADGE)}
                            </span>
                          )}
                        </div>
                        {tool.description && (
                          <div className="text-xs text-muted-foreground">{tool.description}</div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <button
                type="button"
                data-testid="mcp-save-bindings"
                disabled={!canEdit || saving}
                onClick={handleSave}
                className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
              >
                {saving ? tc(MCP_SAVING) : tc(MCP_SAVE_BINDINGS)}
              </button>
            </div>
          );
        })()
      )}
    </section>
  );
}
