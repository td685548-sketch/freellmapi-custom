import { useCustomT } from '../../i18n/use-custom-t';
import type {
  PromptDiffResponse,
  PromptVersionStatus,
  PromptVersionSummary,
} from '../prompts-api';
import {
  PROMPTS_AUTHOR_LABEL,
  PROMPTS_AUTHOR_SYSTEM,
  PROMPTS_DIFF_ERROR,
  PROMPTS_DIFF_FROM_LABEL,
  PROMPTS_DIFF_HEADING,
  PROMPTS_DIFF_LOADING,
  PROMPTS_DIFF_META_LINE,
  PROMPTS_DIFF_NEED_VERSIONS,
  PROMPTS_DIFF_NEW_LINE_COL,
  PROMPTS_DIFF_OLD_LINE_COL,
  PROMPTS_DIFF_STATS,
  PROMPTS_DIFF_TEXT_COL,
  PROMPTS_DIFF_TO_LABEL,
  PROMPTS_NO_NOTE,
  PROMPTS_STATUS_ARCHIVED,
  PROMPTS_STATUS_DRAFT,
  PROMPTS_STATUS_PUBLISHED,
} from '../prompts-strings';

export interface DiffViewProps {
  versions: PromptVersionSummary[];
  fromVersion: number | null;
  toVersion: number | null;
  onChangeFrom: (version: number) => void;
  onChangeTo: (version: number) => void;
  diff: PromptDiffResponse | null;
  loading: boolean;
  error: string | null;
}

function statusLabel(status: PromptVersionStatus, tc: (key: string) => string): string {
  if (status === 'published') return tc(PROMPTS_STATUS_PUBLISHED);
  if (status === 'draft') return tc(PROMPTS_STATUS_DRAFT);
  return tc(PROMPTS_STATUS_ARCHIVED);
}

function formatAuthor(authorId: number | null, tc: (key: string, params?: Record<string, string | number>) => string): string {
  return authorId === null ? tc(PROMPTS_AUTHOR_SYSTEM) : tc(PROMPTS_AUTHOR_LABEL, { id: authorId });
}

export function DiffView({
  versions,
  fromVersion,
  toVersion,
  onChangeFrom,
  onChangeTo,
  diff,
  loading,
  error,
}: DiffViewProps) {
  const tc = useCustomT();

  return (
    <section className="rounded-lg border bg-card p-4 space-y-3" data-testid="prompt-diff-section">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h2 className="text-base font-semibold">{tc(PROMPTS_DIFF_HEADING)}</h2>

        {versions.length > 0 && (
          <div className="flex flex-wrap items-end gap-3">
            <label className="space-y-1 text-xs">
              <span className="font-medium">{tc(PROMPTS_DIFF_FROM_LABEL)}</span>
              <select
                data-testid="prompt-diff-from-select"
                aria-label={tc(PROMPTS_DIFF_FROM_LABEL)}
                className="block rounded border px-2 py-1 text-xs bg-background"
                value={fromVersion ?? ''}
                onChange={(e) => {
                  const val = Number.parseInt(e.target.value, 10);
                  if (Number.isFinite(val)) onChangeFrom(val);
                }}
              >
                {versions.map((v) => (
                  <option key={v.version} value={v.version}>
                    {`v${v.version} (${statusLabel(v.status, tc)})`}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-1 text-xs">
              <span className="font-medium">{tc(PROMPTS_DIFF_TO_LABEL)}</span>
              <select
                data-testid="prompt-diff-to-select"
                aria-label={tc(PROMPTS_DIFF_TO_LABEL)}
                className="block rounded border px-2 py-1 text-xs bg-background"
                value={toVersion ?? ''}
                onChange={(e) => {
                  const val = Number.parseInt(e.target.value, 10);
                  if (Number.isFinite(val)) onChangeTo(val);
                }}
              >
                {versions.map((v) => (
                  <option key={v.version} value={v.version}>
                    {`v${v.version} (${statusLabel(v.status, tc)})`}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
      </div>

      {versions.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="prompt-diff-empty">
          {tc(PROMPTS_DIFF_NEED_VERSIONS)}
        </p>
      ) : loading ? (
        <p className="text-xs text-muted-foreground" data-testid="prompt-diff-loading">
          {tc(PROMPTS_DIFF_LOADING)}
        </p>
      ) : error ? (
        <div
          role="alert"
          data-testid="prompt-diff-error"
          className="rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {error || tc(PROMPTS_DIFF_ERROR)}
        </div>
      ) : diff ? (
        <div className="space-y-3">
          {/* Metadata & summary stats */}
          <div
            className="flex flex-wrap items-center justify-between gap-2 rounded bg-muted/30 px-3 py-2 text-xs"
            data-testid="prompt-diff-metadata"
          >
            <div className="space-y-0.5">
              <div>
                <span className="font-medium">{tc(PROMPTS_DIFF_FROM_LABEL)}: </span>
                <span>
                  {tc(PROMPTS_DIFF_META_LINE, {
                    version: diff.from.version,
                    status: statusLabel(diff.from.status, tc),
                    note: diff.from.note || tc(PROMPTS_NO_NOTE),
                  })}
                </span>
                <span className="text-muted-foreground">
                  {` · ${formatAuthor(diff.from.authorId, tc)} · ${diff.from.createdAt}`}
                </span>
              </div>
              <div>
                <span className="font-medium">{tc(PROMPTS_DIFF_TO_LABEL)}: </span>
                <span>
                  {tc(PROMPTS_DIFF_META_LINE, {
                    version: diff.to.version,
                    status: statusLabel(diff.to.status, tc),
                    note: diff.to.note || tc(PROMPTS_NO_NOTE),
                  })}
                </span>
                <span className="text-muted-foreground">
                  {` · ${formatAuthor(diff.to.authorId, tc)} · ${diff.to.createdAt}`}
                </span>
              </div>
            </div>

            <div className="font-mono text-xs font-semibold" data-testid="prompt-diff-stats">
              {tc(PROMPTS_DIFF_STATS, {
                added: diff.stats.added,
                removed: diff.stats.removed,
                unchanged: diff.stats.unchanged,
              })}
            </div>
          </div>

          {/* Line-by-line hunks */}
          <div className="overflow-x-auto rounded border font-mono text-xs" data-testid="prompt-diff-lines">
            <table className="w-full border-collapse">
              <thead className="bg-muted/40 text-left text-[11px] font-sans text-muted-foreground">
                <tr>
                  <th className="w-12 px-2 py-1 text-right border-r">{tc(PROMPTS_DIFF_OLD_LINE_COL)}</th>
                  <th className="w-12 px-2 py-1 text-right border-r">{tc(PROMPTS_DIFF_NEW_LINE_COL)}</th>
                  <th className="w-6 px-1 py-1 text-center border-r" />
                  <th className="px-2 py-1">{tc(PROMPTS_DIFF_TEXT_COL)}</th>
                </tr>
              </thead>
              <tbody>
                {diff.hunks.map((line, idx) => {
                  const rowCls =
                    line.type === 'add'
                      ? 'bg-emerald-600/15 dark:bg-emerald-400/15 text-emerald-700 dark:text-emerald-400'
                      : line.type === 'remove'
                        ? 'bg-destructive/10 text-destructive'
                        : '';
                  const marker = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
                  return (
                    <tr key={`${idx}-${line.oldLineNumber ?? 'x'}-${line.newLineNumber ?? 'y'}`} className={`border-t ${rowCls}`}>
                      <td className="px-2 py-0.5 text-right text-muted-foreground border-r select-none">
                        {line.oldLineNumber ?? ''}
                      </td>
                      <td className="px-2 py-0.5 text-right text-muted-foreground border-r select-none">
                        {line.newLineNumber ?? ''}
                      </td>
                      <td className="px-1 py-0.5 text-center font-bold border-r select-none">
                        {marker}
                      </td>
                      <td className="px-2 py-0.5 whitespace-pre-wrap break-words">{line.text}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </section>
  );
}
