import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  Bot,
  Edit3,
  ExternalLink,
  Leaf,
  Plus,
  ShieldAlert,
  Trash2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/confirm-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/lib/toast';
import { useCustomT } from '../i18n/use-custom-t';
import { useAdministrativeAccess } from '../use-administrative-access';
import { useUserSession } from '../use-session';
import {
  deleteAdminAssistant,
  fetchAdminAnomalyRadar,
  fetchAdminAssistants,
  patchUpdateAdminAssistant,
  postAdminApplyEcoForUser,
  postCreateAdminAssistant,
  type AdminAssistantPayload,
} from './api';
import {
  ASSISTANT_AUDIENCES,
  ASSISTANT_CATEGORIES,
  KEY_ROUTING_MODES,
  type AdminAiAssistant,
  type AdminAnomalyKind,
  type AssistantAudience,
  type AssistantCategory,
  type KeyRoutingMode,
} from '../../../../shared/customer-ai';

interface EditorDraft {
  id: number | null;
  slug: string;
  name: string;
  description: string;
  category: AssistantCategory;
  recommendedRoutingMode: KeyRoutingMode;
  audience: AssistantAudience;
  enabled: boolean;
  sortOrder: string;
  systemPrompt: string;
  starterPromptsText: string;
}

const emptyDraft = (): EditorDraft => ({
  id: null,
  slug: '',
  name: '',
  description: '',
  category: 'coding',
  recommendedRoutingMode: 'balanced',
  audience: 'all_members',
  enabled: true,
  sortOrder: '50',
  systemPrompt: '',
  starterPromptsText: '',
});

const toDraft = (a: AdminAiAssistant): EditorDraft => ({
  id: a.id,
  slug: a.slug,
  name: a.name,
  description: a.description,
  category: a.category,
  recommendedRoutingMode: a.recommendedRoutingMode,
  audience: a.audience,
  enabled: a.enabled,
  sortOrder: String(a.sortOrder),
  systemPrompt: a.systemPrompt,
  starterPromptsText: a.starterPrompts.join('\n'),
});

const ANOMALY_LABELS: Record<AdminAnomalyKind, string> = {
  token_spike: 'Token spike',
  high_error_loop: 'Error loop',
  unoptimized_heavy_usage: 'Heavy non-Eco usage',
};

const AUDIENCE_LABELS: Record<AssistantAudience, string> = {
  guest_preview: 'Guest preview + Members',
  all_members: 'Signed-in members',
  admin_only: 'Admins only',
};

const CATEGORY_LABELS: Record<AssistantCategory, string> = {
  coding: 'Coding',
  writing: 'Writing',
  data: 'Data & SQL',
  productivity: 'Productivity',
  general: 'General',
};

const MODE_LABELS: Record<KeyRoutingMode, string> = {
  default: 'Inherit global',
  eco: 'Eco (Fast)',
  balanced: 'Balanced',
  max: 'Max Quality',
};

export function AdminCustomerAiPanel() {
  const tc = useCustomT();
  const queryClient = useQueryClient();
  const { can } = useAdministrativeAccess();
  const { isPrimary } = useUserSession();

  const canViewRadar = isPrimary || can('view_ai_platform') || can('edit_ai_flags') || can('manage_ai_platform');
  const canEditFlags = isPrimary || can('edit_ai_flags') || can('manage_ai_platform');
  const canViewStudio = isPrimary || can('view_prompts') || can('edit_prompts') || can('manage_ai_platform');
  const canEditStudio = isPrimary || can('edit_prompts') || can('manage_ai_platform');

  const [draft, setDraft] = useState<EditorDraft | null>(null);

  const { data: radarData, isLoading: radarLoading } = useQuery({
    queryKey: ['admin-anomaly-radar'],
    queryFn: () => fetchAdminAnomalyRadar(24),
    enabled: canViewRadar,
  });

  const { data: studioData, isLoading: studioLoading } = useQuery({
    queryKey: ['admin-customer-assistants'],
    queryFn: () => fetchAdminAssistants(),
    enabled: canViewStudio,
  });

  const refreshAll = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin-customer-assistants'] });
    void queryClient.invalidateQueries({ queryKey: ['admin-anomaly-radar'] });
    void queryClient.invalidateQueries({ queryKey: ['customer-ai-catalog'] });
  };

  const applyEcoForUser = useMutation({
    mutationFn: (userId: number) => postAdminApplyEcoForUser(userId),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ['admin-anomaly-radar'] });
      toast.success(tc('Switched {count} key(s) to Eco mode', { count: res.updatedCount }));
    },
    onError: (err: Error) => toast.error(err.message || tc('Failed to switch keys to Eco mode')),
  });

  const saveAssistant = useMutation({
    mutationFn: async (current: EditorDraft) => {
      const payload: AdminAssistantPayload = {
        slug: current.slug.trim(),
        name: current.name.trim(),
        description: current.description.trim(),
        category: current.category,
        recommendedRoutingMode: current.recommendedRoutingMode,
        audience: current.audience,
        enabled: current.enabled,
        sortOrder: Number.parseInt(current.sortOrder, 10) || 50,
        systemPrompt: current.systemPrompt.trim(),
        starterPrompts: current.starterPromptsText
          .split('\n')
          .map(s => s.trim())
          .filter(Boolean)
          .slice(0, 6),
      };
      if (current.id !== null) {
        return patchUpdateAdminAssistant(current.id, payload);
      }
      return postCreateAdminAssistant(payload);
    },
    onSuccess: () => {
      setDraft(null);
      refreshAll();
      toast.success(tc('Assistant saved'));
    },
    onError: (err: Error) => toast.error(err.message || tc('Failed to save assistant')),
  });

  const toggleEnabled = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      patchUpdateAdminAssistant(id, { enabled }),
    onSuccess: () => {
      refreshAll();
    },
    onError: (err: Error) => toast.error(err.message || tc('Failed to update assistant')),
  });

  const removeAssistant = useMutation({
    mutationFn: (id: number) => deleteAdminAssistant(id),
    onSuccess: () => {
      refreshAll();
      toast.success(tc('Assistant deleted'));
    },
    onError: (err: Error) => toast.error(err.message || tc('Failed to delete assistant')),
  });

  const radar = radarData?.report;
  const assistants = studioData?.assistants ?? [];

  return (
    <div className="space-y-8">
      {/* Section 1: AI Anomaly Radar */}
      {canViewRadar && (
        <section className="space-y-4" aria-label="AI Anomaly Radar">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold flex items-center gap-2">
                <Activity className="size-4 text-primary" />
                {tc('AI Anomaly Radar (24h Fleet Watch)')}
              </h2>
              <p className="text-xs text-muted-foreground">
                {tc('Detects sudden token spikes, high-error retry loops, and heavy non-Eco personal-key traffic across all customer accounts.')}
              </p>
            </div>
          </div>

          {radarLoading ? (
            <div className="rounded-2xl border bg-card p-6 text-xs text-muted-foreground">
              {tc('Scanning fleet activity…')}
            </div>
          ) : radar ? (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="rounded-2xl border bg-card p-4 space-y-1">
                  <div className="text-xs text-muted-foreground">{tc('Published Assistants')}</div>
                  <div className="text-xl font-bold">
                    {radar.enabledAssistants}
                    <span className="text-xs font-normal text-muted-foreground"> / {radar.totalAssistants}</span>
                  </div>
                </div>
                <div className="rounded-2xl border bg-card p-4 space-y-1">
                  <div className="text-xs text-muted-foreground">{tc('Bound Personal Keys')}</div>
                  <div className="text-xl font-bold">{radar.boundPersonalKeys}</div>
                </div>
                <div className="rounded-2xl border bg-card p-4 space-y-1">
                  <div className="text-xs text-muted-foreground">{tc('Eco Mode Keys')}</div>
                  <div className="text-xl font-bold">{radar.ecoPersonalKeys}</div>
                </div>
                <div className="rounded-2xl border bg-card p-4 space-y-1">
                  <div className="text-xs text-muted-foreground">{tc('Active Alerts (24h)')}</div>
                  <div className="text-xl font-bold">{radar.anomalies.length}</div>
                </div>
              </div>

              <div className="rounded-2xl border bg-card overflow-hidden">
                <div className="border-b px-5 py-3 flex items-center justify-between">
                  <span className="text-xs font-semibold flex items-center gap-1.5">
                    <ShieldAlert className="size-3.5 text-amber-500" />
                    {tc('Account Anomaly Alerts')}
                  </span>
                </div>
                {radar.anomalies.length === 0 ? (
                  <div className="p-6 text-xs text-muted-foreground">
                    {tc('No abnormal token spikes or retry loops detected in the last 24 hours.')}
                  </div>
                ) : (
                  <div className="divide-y">
                    {radar.anomalies.map((item) => (
                      <div
                        key={item.id}
                        className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                      >
                        <div className="space-y-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium">{item.email}</span>
                            <span
                              className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                                item.severity === 'high'
                                  ? 'bg-destructive/10 text-destructive'
                                  : item.severity === 'medium'
                                    ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
                                    : 'bg-muted text-muted-foreground'
                              }`}
                            >
                              {tc(ANOMALY_LABELS[item.kind])}
                            </span>
                          </div>
                          <p className="text-xs text-muted-foreground">{item.summary}</p>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          {canEditFlags && item.activeNonEcoKeys > 0 && (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={applyEcoForUser.isPending}
                              onClick={() => applyEcoForUser.mutate(item.userId)}
                              className="text-xs"
                            >
                              <Leaf className="size-3.5 mr-1" />
                              {tc('Force Eco Mode')}
                            </Button>
                          )}
                          <Link
                            to={`/users/${item.userId}/analytics`}
                            className="inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs hover:bg-muted transition-colors"
                          >
                            {tc('Inspect User')}
                            <ExternalLink className="size-3" />
                          </Link>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : null}
        </section>
      )}

      {/* Section 2: Customer Assistants Studio */}
      {canViewStudio && (
        <section className="space-y-4" aria-label="Customer Assistants Studio">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold flex items-center gap-2">
                <Bot className="size-4 text-primary" />
                {tc('Customer Assistants Studio')}
              </h2>
              <p className="text-xs text-muted-foreground">
                {tc('Author system prompts, set audience visibility (Guest / Member / Admin), and monitor key bindings. Customers never see the raw system prompt.')}
              </p>
            </div>
            {canEditStudio && (
              <Button type="button" size="sm" onClick={() => setDraft(emptyDraft())}>
                <Plus className="size-3.5 mr-1" />
                {tc('New Assistant')}
              </Button>
            )}
          </div>

          {studioLoading ? (
            <div className="rounded-2xl border bg-card p-6 text-xs text-muted-foreground">
              {tc('Loading assistants…')}
            </div>
          ) : (
            <div className="rounded-2xl border bg-card divide-y overflow-hidden">
              {assistants.map((a) => (
                <div key={a.id} className="p-4 space-y-2">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-sm">{a.name}</span>
                        <code className="text-[11px] font-mono bg-muted px-1.5 py-0.5 rounded">{a.slug}</code>
                        <span className="rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground">
                          {tc(CATEGORY_LABELS[a.category])}
                        </span>
                        <span className="rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground">
                          {tc(AUDIENCE_LABELS[a.audience])}
                        </span>
                        {!a.enabled && (
                          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                            {tc('Disabled')}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">{a.description}</p>
                      <div className="text-[11px] text-muted-foreground flex flex-wrap gap-3">
                        <span>{tc('Recommended: {mode}', { mode: tc(MODE_LABELS[a.recommendedRoutingMode]) })}</span>
                        <span>{tc('Bound keys: {count}', { count: a.boundKeysCount })}</span>
                        <span>{tc('Hub chats: {count}', { count: a.playgroundRuns })}</span>
                      </div>
                    </div>

                    {canEditStudio && (
                      <div className="flex items-center gap-1.5 shrink-0">
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          onClick={() => toggleEnabled.mutate({ id: a.id, enabled: !a.enabled })}
                        >
                          {a.enabled ? tc('Disable') : tc('Enable')}
                        </Button>
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          aria-label={`Edit ${a.name}`}
                          onClick={() => setDraft(toDraft(a))}
                        >
                          <Edit3 className="size-3 mr-1" />
                          {tc('Edit')}
                        </Button>
                        <ConfirmButton
                          aria-label={`Delete ${a.name}`}
                          confirmLabel={tc('Confirm delete')}
                          onConfirm={() => removeAssistant.mutate(a.id)}
                          disabled={removeAssistant.isPending}
                        >
                          <Trash2 className="size-3" />
                        </ConfirmButton>
                      </div>
                    )}
                  </div>
                  <div className="rounded-xl bg-muted/40 border px-3 py-2 text-[11px] font-mono text-muted-foreground line-clamp-2">
                    {a.systemPrompt}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Editor Modal */}
      {draft && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
          onClick={() => setDraft(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={draft.id === null ? tc('Create AI Assistant') : tc('Edit AI Assistant')}
            className="w-full max-w-xl max-h-[90vh] overflow-y-auto rounded-3xl border bg-card p-6 shadow-xl space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold">
                {draft.id === null ? tc('Create AI Assistant') : tc('Edit AI Assistant')}
              </h3>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={tc('Close')} onClick={() => setDraft(null)}>
                <X className="size-4" />
              </Button>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="ai-name" className="text-xs">{tc('Display name')}</Label>
                <Input
                  id="ai-name"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder={tc('e.g. Security Auditor')}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="ai-slug" className="text-xs">{tc('Slug')}</Label>
                <Input
                  id="ai-slug"
                  value={draft.slug}
                  onChange={(e) => setDraft({ ...draft, slug: e.target.value })}
                  placeholder="security-auditor"
                />
              </div>
            </div>

            <div className="space-y-1">
              <Label htmlFor="ai-desc" className="text-xs">{tc('Customer description')}</Label>
              <Input
                id="ai-desc"
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                placeholder={tc('Short summary shown on customer cards')}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1">
                <Label htmlFor="ai-cat" className="text-xs">{tc('Category')}</Label>
                <select
                  id="ai-cat"
                  value={draft.category}
                  onChange={(e) => setDraft({ ...draft, category: e.target.value as AssistantCategory })}
                  className="h-9 w-full rounded-lg border bg-background px-2.5 text-xs"
                >
                  {ASSISTANT_CATEGORIES.map(c => (
                    <option key={c} value={c}>{tc(CATEGORY_LABELS[c])}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="ai-mode" className="text-xs">{tc('Recommended routing')}</Label>
                <select
                  id="ai-mode"
                  value={draft.recommendedRoutingMode}
                  onChange={(e) => setDraft({ ...draft, recommendedRoutingMode: e.target.value as KeyRoutingMode })}
                  className="h-9 w-full rounded-lg border bg-background px-2.5 text-xs"
                >
                  {KEY_ROUTING_MODES.map(m => (
                    <option key={m} value={m}>{tc(MODE_LABELS[m])}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="ai-audience" className="text-xs">{tc('Audience')}</Label>
                <select
                  id="ai-audience"
                  value={draft.audience}
                  onChange={(e) => setDraft({ ...draft, audience: e.target.value as AssistantAudience })}
                  className="h-9 w-full rounded-lg border bg-background px-2.5 text-xs"
                >
                  {ASSISTANT_AUDIENCES.map(aud => (
                    <option key={aud} value={aud}>{tc(AUDIENCE_LABELS[aud])}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="space-y-1">
              <Label htmlFor="ai-sys-prompt" className="text-xs">{tc('Server system prompt (hidden from customers)')}</Label>
              <Textarea
                id="ai-sys-prompt"
                rows={4}
                value={draft.systemPrompt}
                onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })}
                placeholder={tc('Enter instructions enforced on the server…')}
                className="text-xs font-mono"
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="ai-starters" className="text-xs">{tc('Starter prompts (one per line)')}</Label>
              <Textarea
                id="ai-starters"
                rows={3}
                value={draft.starterPromptsText}
                onChange={(e) => setDraft({ ...draft, starterPromptsText: e.target.value })}
                placeholder={tc('Review this code for security flaws...')}
                className="text-xs"
              />
            </div>

            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
              />
              <span>{tc('Enabled and visible to eligible audience')}</span>
            </label>

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="ghost" onClick={() => setDraft(null)}>{tc('Cancel')}</Button>
              <Button
                type="button"
                disabled={
                  saveAssistant.isPending ||
                  draft.name.trim().length < 2 ||
                  draft.slug.trim().length < 2 ||
                  draft.systemPrompt.trim().length < 4
                }
                onClick={() => saveAssistant.mutate(draft)}
              >
                {saveAssistant.isPending ? tc('Saving…') : tc('Save Assistant')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
