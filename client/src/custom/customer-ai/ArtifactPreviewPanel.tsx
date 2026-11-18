import { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Code2, Copy, Download, Eye, ShieldCheck, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from '@/lib/toast';
import {
  sanitizeArtifactHtml,
  sanitizeArtifactSvg,
  type DetectedAssistantArtifact,
} from '../../../../shared/customer-ai';
import { formatWorkspaceString, useWorkspaceStrings } from './strings';

interface MermaidNode {
  id: string;
  label: string;
}

interface MermaidEdge {
  from: string;
  to: string;
  label: string;
}

function parseSimpleMermaidGraph(source: string): {
  direction: 'LR' | 'TD';
  nodes: MermaidNode[];
  edges: MermaidEdge[];
} {
  const lines = source
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('%%'));

  const header = lines[0] ?? '';
  const direction: 'LR' | 'TD' = /\bLR\b/i.test(header) ? 'LR' : 'TD';
  const nodeMap = new Map<string, string>();
  const edges: MermaidEdge[] = [];

  const registerNode = (rawToken: string): string => {
    const trimmed = rawToken.trim();
    const match = trimmed.match(/^([A-Za-z0-9_.-]+)\s*(?:\[\s*"?([^"\]]+)"?\s*\]|\(\s*"?([^")]+)"?\s*\)|\{\s*"?([^"}]+)"?\s*\})?$/);
    if (!match) {
      const fallbackId = trimmed.replace(/[^A-Za-z0-9_.-]/g, '') || 'node';
      if (!nodeMap.has(fallbackId)) nodeMap.set(fallbackId, trimmed);
      return fallbackId;
    }
    const id = match[1]!;
    const label = (match[2] ?? match[3] ?? match[4] ?? '').trim();
    if (label || !nodeMap.has(id)) {
      nodeMap.set(id, label || id);
    }
    return id;
  };

  for (let idx = 1; idx < lines.length; idx += 1) {
    const line = lines[idx]!;
    if (/^(?:subgraph|end|classDef|class|style|linkStyle|click)\b/i.test(line)) continue;

    // Sequence diagram arrow (`Alice ->> Bob: Hello`)
    const seqMatch = line.match(/^([A-Za-z0-9_.-]+)\s*-+>+>?[+-]?\s*([A-Za-z0-9_.-]+)\s*:\s*(.+)$/);
    if (seqMatch) {
      const from = registerNode(seqMatch[1]!);
      const to = registerNode(seqMatch[2]!);
      edges.push({ from, to, label: seqMatch[3]!.trim() });
      continue;
    }

    // Flowchart arrow (`A[Start] -->|label| B[End]` or `A -- label --> B`)
    const flowMatch = line.match(/^(.+?)\s*(?:--+>\s*(?:\|([^|]+)\|)?|--\s*([^-]+?)\s*-->|==+>\s*(?:\|([^|]+)\|)?|-\.+->\s*(?:\|([^|]+)\|)?)\s*(.+)$/);
    if (flowMatch) {
      const from = registerNode(flowMatch[1]!);
      const to = registerNode(flowMatch[6]!);
      const edgeLabel = (flowMatch[2] ?? flowMatch[3] ?? flowMatch[4] ?? flowMatch[5] ?? '').trim();
      edges.push({ from, to, label: edgeLabel });
      continue;
    }

    if (/^[A-Za-z0-9_.-]+\s*[[({]/.test(line)) {
      registerNode(line);
    }
  }

  return {
    direction,
    nodes: Array.from(nodeMap.entries()).map(([id, label]) => ({ id, label })),
    edges,
  };
}

function extractCodeSymbols(code: string): string[] {
  const symbols = new Set<string>();
  const regex = /\b(?:export\s+(?:default\s+)?)?(?:function|const|class|interface|type)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(code)) !== null) {
    if (match[1]) symbols.add(match[1]);
    if (symbols.size >= 8) break;
  }
  return Array.from(symbols);
}

function downloadTextAsFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

function mimeForArtifact(artifact: DetectedAssistantArtifact): string {
  switch (artifact.kind) {
    case 'html':
      return 'text/html';
    case 'svg':
      return 'image/svg+xml';
    case 'json':
      return 'application/json';
    case 'markdown':
      return 'text/markdown';
    default:
      return 'text/plain';
  }
}

export function ArtifactPreviewPanel({
  artifacts,
  activeArtifactId,
  onSelectArtifact,
  onClose,
}: {
  artifacts: DetectedAssistantArtifact[];
  activeArtifactId: string;
  onSelectArtifact: (id: string) => void;
  onClose: () => void;
}) {
  const ws = useWorkspaceStrings();
  const [tab, setTab] = useState<'preview' | 'code'>('preview');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const active = useMemo(
    () => artifacts.find(a => a.id === activeArtifactId) ?? artifacts[0] ?? null,
    [artifacts, activeArtifactId],
  );

  const sanitizedHtml = useMemo(
    () => (active?.kind === 'html' ? sanitizeArtifactHtml(active.content) : ''),
    [active],
  );

  const sanitizedSvg = useMemo(
    () => (active?.kind === 'svg' ? sanitizeArtifactSvg(active.content) : ''),
    [active],
  );

  const parsedJson = useMemo(() => {
    if (active?.kind !== 'json') return null;
    try {
      const value: unknown = JSON.parse(active.content);
      return { ok: true as const, formatted: JSON.stringify(value, null, 2), value };
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : 'Invalid JSON',
      };
    }
  }, [active]);

  const mermaidGraph = useMemo(
    () => (active?.kind === 'mermaid' ? parseSimpleMermaidGraph(active.content) : null),
    [active],
  );

  const codeSymbols = useMemo(
    () => (active?.kind === 'code' ? extractCodeSymbols(active.content) : []),
    [active],
  );

  if (!active) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(active.content);
      setCopiedId(active.id);
      setTimeout(() => setCopiedId(prev => (prev === active.id ? null : prev)), 1800);
    } catch {
      toast.error('Clipboard copy failed');
    }
  };

  const handleDownload = () => {
    downloadTextAsFile(active.content, active.suggestedFilename, mimeForArtifact(active));
  };

  return (
    <aside
      aria-label={ws.artifactPanelTitle}
      className="flex h-full w-full flex-col border-t lg:border-t-0 lg:border-l bg-muted/20 min-w-0"
    >
      {/* Top Toolbar */}
      <div className="flex items-center justify-between gap-2 border-b bg-card px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold truncate">{active.title}</span>
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 px-2 py-0.5 text-[10px] font-medium shrink-0">
              <ShieldCheck className="size-3" />
              {ws.cspSafeBadge}
            </span>
          </div>
          <p className="text-[11px] text-muted-foreground font-mono truncate">{active.suggestedFilename}</p>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <div className="inline-flex rounded-lg border bg-background p-0.5">
            <button
              type="button"
              onClick={() => setTab('preview')}
              className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors ${
                tab === 'preview'
                  ? 'bg-foreground text-background font-medium'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Eye className="size-3" />
              {ws.tabVisualPreview}
            </button>
            <button
              type="button"
              onClick={() => setTab('code')}
              className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors ${
                tab === 'code'
                  ? 'bg-foreground text-background font-medium'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Code2 className="size-3" />
              {ws.tabRawSource}
            </button>
          </div>

          <Button type="button" variant="outline" size="xs" onClick={handleCopy}>
            {copiedId === active.id ? (
              <>
                <Check className="size-3 mr-1 text-emerald-600" />
                {ws.copiedArtifact}
              </>
            ) : (
              <>
                <Copy className="size-3 mr-1" />
                {ws.copyArtifact}
              </>
            )}
          </Button>

          <Button type="button" variant="outline" size="xs" onClick={handleDownload}>
            <Download className="size-3 mr-1" />
            {ws.downloadArtifact}
          </Button>

          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={ws.closePreview}
            onClick={onClose}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Multi-Artifact Selector Tabs */}
      {artifacts.length > 1 && (
        <div className="flex items-center gap-1.5 overflow-x-auto border-b bg-card/60 px-3 py-1.5">
          {artifacts.map(item => (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectArtifact(item.id)}
              className={`rounded-lg px-2.5 py-1 text-[11px] whitespace-nowrap transition-colors ${
                item.id === active.id
                  ? 'bg-primary text-primary-foreground font-medium'
                  : 'border bg-background text-muted-foreground hover:text-foreground'
              }`}
            >
              {item.title}
            </button>
          ))}
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-auto p-4">
        {tab === 'code' ? (
          <pre className="rounded-xl border bg-background p-4 text-xs font-mono leading-relaxed overflow-x-auto whitespace-pre">
            <code>{active.content}</code>
          </pre>
        ) : active.kind === 'markdown' ? (
          <div className="rounded-xl border bg-background p-5 text-xs leading-relaxed space-y-3 prose-sm max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{active.content}</ReactMarkdown>
          </div>
        ) : active.kind === 'svg' ? (
          <div
            data-testid="artifact-svg-preview"
            className="flex min-h-56 items-center justify-center rounded-xl border bg-background p-6 overflow-auto [&_svg]:max-h-96 [&_svg]:max-w-full"
            dangerouslySetInnerHTML={{ __html: sanitizedSvg }}
          />
        ) : active.kind === 'html' ? (
          <div
            data-testid="artifact-html-preview"
            className="rounded-xl border bg-background p-5 text-xs leading-relaxed space-y-2 overflow-auto [&_table]:w-full [&_table]:border-collapse [&_th]:border [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:bg-muted/50 [&_td]:border [&_td]:px-2.5 [&_td]:py-1.5"
            dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
          />
        ) : active.kind === 'json' && parsedJson ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between rounded-xl border bg-background px-3.5 py-2 text-xs">
              <span
                className={
                  parsedJson.ok
                    ? 'font-medium text-emerald-600 dark:text-emerald-400'
                    : 'font-medium text-destructive'
                }
              >
                {parsedJson.ok ? ws.jsonValidBadge : `${ws.jsonInvalidBadge}: ${parsedJson.error}`}
              </span>
              {parsedJson.ok && typeof parsedJson.value === 'object' && parsedJson.value !== null && (
                <span className="text-[11px] text-muted-foreground font-mono">
                  {Array.isArray(parsedJson.value)
                    ? `[${parsedJson.value.length}]`
                    : `{${Object.keys(parsedJson.value as Record<string, unknown>).length} keys}`}
                </span>
              )}
            </div>
            <pre className="rounded-xl border bg-background p-4 text-xs font-mono leading-relaxed overflow-x-auto whitespace-pre">
              <code>{parsedJson.ok ? parsedJson.formatted : active.content}</code>
            </pre>
          </div>
        ) : active.kind === 'mermaid' && mermaidGraph ? (
          <div className="space-y-3">
            {mermaidGraph.nodes.length > 0 ? (
              <div className="rounded-xl border bg-background p-4 space-y-3 overflow-x-auto">
                <div className="text-[11px] text-muted-foreground">
                  {formatWorkspaceString(ws.mermaidFlowSummary, {
                    nodes: mermaidGraph.nodes.length,
                    edges: mermaidGraph.edges.length,
                  })}
                </div>
                <svg
                  role="img"
                  aria-label={active.title}
                  viewBox={`0 0 ${mermaidGraph.direction === 'LR' ? Math.max(420, mermaidGraph.nodes.length * 165) : 420} ${
                    mermaidGraph.direction === 'LR' ? 160 : Math.max(140, mermaidGraph.nodes.length * 76 + 24)
                  }`}
                  className="w-full max-h-96"
                >
                  <defs>
                    <marker
                      id="artifact-arrow"
                      markerWidth="8"
                      markerHeight="8"
                      refX="7"
                      refY="4"
                      orient="auto"
                    >
                      <path d="M0,0 L8,4 L0,8 Z" fill="currentColor" className="text-muted-foreground" />
                    </marker>
                  </defs>
                  {mermaidGraph.edges.map((edge, idx) => {
                    const fromIdx = mermaidGraph.nodes.findIndex(n => n.id === edge.from);
                    const toIdx = mermaidGraph.nodes.findIndex(n => n.id === edge.to);
                    if (fromIdx < 0 || toIdx < 0) return null;
                    if (mermaidGraph.direction === 'LR') {
                      const x1 = fromIdx * 160 + 132;
                      const y1 = 76;
                      const x2 = toIdx * 160 + 20;
                      const y2 = 76;
                      return (
                        <g key={idx}>
                          <line
                            x1={x1}
                            y1={y1}
                            x2={x2}
                            y2={y2}
                            stroke="currentColor"
                            strokeWidth="1.5"
                            markerEnd="url(#artifact-arrow)"
                            className="text-muted-foreground"
                          />
                          {edge.label && (
                            <text
                              x={(x1 + x2) / 2}
                              y={y1 - 8}
                              textAnchor="middle"
                              fontSize="10"
                              fill="currentColor"
                              className="text-muted-foreground"
                            >
                              {edge.label.slice(0, 22)}
                            </text>
                          )}
                        </g>
                      );
                    }
                    const x1 = 210;
                    const y1 = fromIdx * 72 + 52;
                    const x2 = 210;
                    const y2 = toIdx * 72 + 16;
                    return (
                      <g key={idx}>
                        <line
                          x1={x1}
                          y1={y1}
                          x2={x2}
                          y2={y2}
                          stroke="currentColor"
                          strokeWidth="1.5"
                          markerEnd="url(#artifact-arrow)"
                          className="text-muted-foreground"
                        />
                        {edge.label && (
                          <text
                            x={x1 + 8}
                            y={(y1 + y2) / 2 + 3}
                            fontSize="10"
                            fill="currentColor"
                            className="text-muted-foreground"
                          >
                            {edge.label.slice(0, 28)}
                          </text>
                        )}
                      </g>
                    );
                  })}
                  {mermaidGraph.nodes.map((node, idx) => {
                    const x = mermaidGraph.direction === 'LR' ? idx * 160 + 20 : 110;
                    const y = mermaidGraph.direction === 'LR' ? 54 : idx * 72 + 16;
                    const w = mermaidGraph.direction === 'LR' ? 112 : 200;
                    return (
                      <g key={node.id}>
                        <rect
                          x={x}
                          y={y}
                          width={w}
                          height="36"
                          rx="10"
                          fill="currentColor"
                          className="text-muted/70"
                          stroke="currentColor"
                          strokeOpacity="0.3"
                        />
                        <text
                          x={x + w / 2}
                          y={y + 22}
                          textAnchor="middle"
                          fontSize="11"
                          fontWeight="500"
                          fill="currentColor"
                          className="text-foreground"
                        >
                          {node.label.length > 22 ? `${node.label.slice(0, 20)}…` : node.label}
                        </text>
                      </g>
                    );
                  })}
                </svg>
              </div>
            ) : null}
            <pre className="rounded-xl border bg-background p-4 text-xs font-mono leading-relaxed overflow-x-auto whitespace-pre">
              <code>{active.content}</code>
            </pre>
          </div>
        ) : (
          <div className="space-y-3">
            {codeSymbols.length > 0 && (
              <div className="rounded-xl border bg-background px-3.5 py-2 text-[11px] text-muted-foreground">
                {formatWorkspaceString(ws.codeExportsSummary, {
                  symbols: codeSymbols.join(', '),
                })}
              </div>
            )}
            <pre className="rounded-xl border bg-background p-4 text-xs font-mono leading-relaxed overflow-x-auto whitespace-pre">
              <code>{active.content}</code>
            </pre>
          </div>
        )}
      </div>
    </aside>
  );
}
