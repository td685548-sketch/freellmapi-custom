import { useEffect, useRef, useState } from 'react';
import { useCustomT } from '../../i18n/use-custom-t';
import {
  reviewMcpTool,
  type McpServerView,
  type McpToolEffect,
  type McpToolState,
  type McpToolView,
} from '../mcp-api';
import {
  MCP_ACTION_FORBIDDEN,
  MCP_EFFECT_READ,
  MCP_EFFECT_WRITE,
  MCP_LOADING_TOOLS,
  MCP_NO_TOOLS,
  MCP_SELECT_SERVER_HINT,
  MCP_STATE_ALLOWED,
  MCP_STATE_BLOCKED,
  MCP_STATE_MISSING,
  MCP_STATE_PENDING,
  MCP_TOOLS_HEADING,
  MCP_TOOL_ALLOW,
  MCP_TOOL_BLOCK,
  MCP_TOOL_EFFECT,
  MCP_TOOL_EXPOSED,
  MCP_TOOL_HASH,
  MCP_TOOL_NAME,
  MCP_TOOL_READONLY_NOTICE,
  MCP_TOOL_REQUIRES_REVIEW_PERM,
  MCP_TOOL_SCHEMA,
  MCP_TOOL_STATE,
} from '../mcp-strings';

interface ToolReviewTableProps {
  server: McpServerView | null;
  tools: McpToolView[];
  loading: boolean;
  error: string | null;
  canReview: boolean;
  onReviewed: (tool: McpToolView) => void;
}

const STATE_LABEL: Record<McpToolState, string> = {
  pending: MCP_STATE_PENDING,
  allowed: MCP_STATE_ALLOWED,
  blocked: MCP_STATE_BLOCKED,
  missing: MCP_STATE_MISSING,
};

export function ToolReviewTable({
  server,
  tools,
  loading,
  error,
  canReview,
  onReviewed,
}: ToolReviewTableProps) {
  const tc = useCustomT();
  const [draftEffects, setDraftEffects] = useState<Record<number, McpToolEffect>>({});
  const [pendingId, setPendingId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const epochRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  async function handleReview(tool: McpToolView, nextState: 'allowed' | 'blocked') {
    if (!canReview || pendingId !== null) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const callEpoch = epochRef.current;
    const chosenEffect = draftEffects[tool.id] ?? tool.effect;

    setPendingId(tool.id);
    setActionError(null);
    try {
      const res = await reviewMcpTool(
        tool.id,
        { state: nextState, effect: chosenEffect },
        ac.signal,
      );
      if (!mountedRef.current || callEpoch !== epochRef.current) return;
      onReviewed(res.tool);
    } catch (err: unknown) {
      if (!mountedRef.current || callEpoch !== epochRef.current) return;
      if ((err as { name?: string })?.name === 'AbortError') return;
      const status = (err as { status?: number })?.status;
      setActionError(
        status === 403
          ? tc(MCP_ACTION_FORBIDDEN)
          : (err as Error)?.message ?? 'Failed to review tool',
      );
    } finally {
      if (mountedRef.current && callEpoch === epochRef.current) {
        setPendingId(null);
      }
    }
  }

  return (
    <section className="rounded-lg border bg-card p-4 space-y-3" data-testid="mcp-tool-review-section">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-medium">
          {tc(MCP_TOOLS_HEADING)}
          {server ? ` — ${server.slug}` : ''}
        </h3>
        {!canReview && (
          <span className="text-xs text-muted-foreground">{tc(MCP_TOOL_REQUIRES_REVIEW_PERM)}</span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{tc(MCP_TOOL_READONLY_NOTICE)}</p>

      {actionError && (
        <div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
          {actionError}
        </div>
      )}
      {error && (
        <div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
          {error}
        </div>
      )}

      {!server ? (
        <p className="text-sm text-muted-foreground">{tc(MCP_SELECT_SERVER_HINT)}</p>
      ) : loading ? (
        <p className="text-sm text-muted-foreground">{tc(MCP_LOADING_TOOLS)}</p>
      ) : tools.length === 0 ? (
        <p className="text-sm text-muted-foreground">{tc(MCP_NO_TOOLS)}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-2 pr-3">{tc(MCP_TOOL_NAME)}</th>
                <th className="py-2 pr-3">{tc(MCP_TOOL_EXPOSED)}</th>
                <th className="py-2 pr-3">{tc(MCP_TOOL_HASH)}</th>
                <th className="py-2 pr-3">{tc(MCP_TOOL_EFFECT)}</th>
                <th className="py-2 pr-3">{tc(MCP_TOOL_STATE)}</th>
                <th className="py-2 pr-3">{tc(MCP_TOOL_SCHEMA)}</th>
                <th className="py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {tools.map((tool) => {
                const effectValue = draftEffects[tool.id] ?? tool.effect;
                const isBusy = pendingId === tool.id;
                const disabled = !canReview || isBusy || tool.state === 'missing';
                return (
                  <tr key={tool.id} className="border-b last:border-b-0 align-top">
                    <td className="py-2 pr-3">
                      <div className="font-medium">{tool.name}</div>
                      {tool.description && (
                        <div className="text-xs text-muted-foreground mt-0.5">{tool.description}</div>
                      )}
                    </td>
                    <td className="py-2 pr-3 font-mono text-xs">{tool.exposedName}</td>
                    <td className="py-2 pr-3 font-mono text-xs">{tool.schemaHash}</td>
                    <td className="py-2 pr-3">
                      <select
                        aria-label={`${tc(MCP_TOOL_EFFECT)} ${tool.name}`}
                        data-testid={`mcp-tool-effect-${tool.id}`}
                        value={effectValue}
                        disabled={!canReview || isBusy}
                        onChange={(e) => {
                          const val = e.target.value as McpToolEffect;
                          setDraftEffects((prev) => ({ ...prev, [tool.id]: val }));
                        }}
                        className="rounded border bg-background px-2 py-1 text-xs"
                      >
                        <option value="write">{tc(MCP_EFFECT_WRITE)}</option>
                        <option value="read">{tc(MCP_EFFECT_READ)}</option>
                      </select>
                    </td>
                    <td className="py-2 pr-3">
                      <span className="inline-block rounded bg-muted px-2 py-0.5 text-xs">
                        {tc(STATE_LABEL[tool.state])}
                      </span>
                    </td>
                    <td className="py-2 pr-3">
                      <pre className="max-w-xs overflow-x-auto rounded bg-muted/50 p-1.5 text-[11px] font-mono">
                        {JSON.stringify(tool.inputSchema)}
                      </pre>
                    </td>
                    <td className="py-2 text-right whitespace-nowrap space-x-1">
                      <button
                        type="button"
                        data-testid={`mcp-tool-allow-${tool.id}`}
                        disabled={disabled}
                        onClick={() => handleReview(tool, 'allowed')}
                        className="rounded border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {tc(MCP_TOOL_ALLOW)}
                      </button>
                      <button
                        type="button"
                        data-testid={`mcp-tool-block-${tool.id}`}
                        disabled={disabled}
                        onClick={() => handleReview(tool, 'blocked')}
                        className="rounded border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {tc(MCP_TOOL_BLOCK)}
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
  );
}
