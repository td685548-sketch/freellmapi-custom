import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, KeyRound, Leaf, MessageSquare, Shield, SlidersHorizontal, Sparkles } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { apiFetch } from '@/lib/api';
import { toast } from '@/lib/toast';
import type { UserApiKey } from '../../../../shared/user-access';
import {
  ASSISTANT_CATEGORIES,
  type AssistantCategory,
  type CustomerAiAssistant,
  type KeyRoutingMode,
} from '../../../../shared/customer-ai';
import { askToSignIn } from '../guest-prompt';
import { useCustomT } from '../i18n/use-custom-t';
import { useAdministrativeAccess } from '../use-administrative-access';
import { useUserSession } from '../use-session';
import {
  fetchCustomerAssistants,
  fetchUserAiPreferences,
  patchUserKeyAiConfig,
  putUserAiPreferences,
} from './api';
import { AssistantChatDrawer } from './AssistantChatDrawer';
import { QuotaCoachCard } from './QuotaCoachCard';
import { AdminCustomerAiPanel } from './AdminCustomerAiPanel';

const CATEGORY_LABELS: Record<AssistantCategory, string> = {
  coding: 'Coding',
  writing: 'Writing',
  data: 'Data & SQL',
  productivity: 'Productivity',
  general: 'General',
};

const MODE_BADGES: Record<KeyRoutingMode, string> = {
  default: 'Inherit global',
  eco: 'Eco (Fast)',
  balanced: 'Balanced',
  max: 'Max Quality',
};

export function CustomerAiHubPage({ guestMode = false }: { guestMode?: boolean }) {
  const tc = useCustomT();
  const queryClient = useQueryClient();
  const { isPrimary } = useUserSession();
  const { can } = useAdministrativeAccess();

  const hasAdminAccess = !guestMode && (
    isPrimary ||
    can('view_prompts') ||
    can('edit_prompts') ||
    can('view_ai_platform') ||
    can('edit_ai_flags') ||
    can('manage_ai_platform')
  );

  const [personaView, setPersonaView] = useState<'customer' | 'admin'>('customer');
  const [category, setCategory] = useState<'all' | AssistantCategory>('all');
  const [activeAssistant, setActiveAssistant] = useState<CustomerAiAssistant | null>(null);
  const [selectedBindKeyId, setSelectedBindKeyId] = useState<string>('');
  const [draftPrefs, setDraftPrefs] = useState<{ customInstructions: string; applyToKeys: boolean } | null>(null);

  const { data: catalogData, isLoading: catalogLoading } = useQuery({
    queryKey: ['customer-ai-catalog', guestMode ? 'guest' : 'user'],
    queryFn: () => fetchCustomerAssistants(),
  });

  const { data: prefsData } = useQuery({
    queryKey: ['customer-ai-preferences'],
    queryFn: () => fetchUserAiPreferences(),
    enabled: !guestMode,
  });

  const { data: keysData } = useQuery<{ keys: UserApiKey[] }>({
    queryKey: ['user-api-keys'],
    queryFn: () => apiFetch<{ keys: UserApiKey[] }>('/api/user/keys'),
    enabled: !guestMode,
  });

  const instructions = draftPrefs
    ? draftPrefs.customInstructions
    : (prefsData?.preferences.customInstructions ?? '');
  const applyToKeys = draftPrefs
    ? draftPrefs.applyToKeys
    : (prefsData?.preferences.applyCustomInstructionsToKeys ?? true);

  const activeKeys = useMemo(
    () => (Array.isArray(keysData?.keys) ? keysData.keys.filter(k => !k.revoked) : []),
    [keysData],
  );

  const effectiveBindKeyId = activeKeys.some(k => String(k.id) === selectedBindKeyId)
    ? selectedBindKeyId
    : (activeKeys[0] ? String(activeKeys[0].id) : '');

  const savePrefs = useMutation({
    mutationFn: () =>
      putUserAiPreferences({
        customInstructions: instructions,
        applyCustomInstructionsToKeys: applyToKeys,
      }),
    onSuccess: (res) => {
      queryClient.setQueryData(['customer-ai-preferences'], res);
      setDraftPrefs(null);
      toast.success(tc('Custom instructions saved'));
    },
    onError: (err: Error) => toast.error(err.message || tc('Failed to save custom instructions')),
  });

  const bindKeyMutation = useMutation({
    mutationFn: ({ keyId, assistant }: { keyId: number; assistant: CustomerAiAssistant }) =>
      patchUserKeyAiConfig(keyId, {
        assistantId: assistant.id,
        routingMode: assistant.recommendedRoutingMode,
      }),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ['user-api-keys'] });
      void queryClient.invalidateQueries({ queryKey: ['customer-ai-catalog'] });
      void queryClient.invalidateQueries({ queryKey: ['customer-ai-coach'] });
      toast.success(
        tc('Bound "{name}" preset to personal API key', {
          name: res.key.assistantName ?? 'Assistant',
        }),
      );
    },
    onError: (err: Error) => toast.error(err.message || tc('Failed to bind preset to key')),
  });

  const assistants = useMemo(
    () => (Array.isArray(catalogData?.assistants) ? catalogData.assistants : []),
    [catalogData],
  );

  const visibleAssistants = useMemo(
    () => (category === 'all' ? assistants : assistants.filter(a => a.category === category)),
    [assistants, category],
  );

  const prefsDirty =
    prefsData?.preferences !== undefined &&
    (instructions !== prefsData.preferences.customInstructions ||
      applyToKeys !== prefsData.preferences.applyCustomInstructionsToKeys);

  return (
    <div className="space-y-8">
      <PageHeader
        title={guestMode ? tc('AI Assistants Catalog') : tc('AI Hub & Smart Routing')}
        description={
          guestMode
            ? tc('Explore curated AI assistants ready to attach to personal API keys or chat once you sign in.')
            : tc('Chat with curated AI assistants, customize personal instructions, bind presets to your API keys, and optimize quota with Eco/Balanced/Max routing.')
        }
        actions={
          hasAdminAccess ? (
            <div className="inline-flex rounded-xl border p-1 gap-1">
              <button
                type="button"
                onClick={() => setPersonaView('customer')}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs transition-colors ${
                  personaView === 'customer'
                    ? 'bg-foreground text-background font-medium'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <Sparkles className="size-3.5" />
                {tc('Customer View')}
              </button>
              <button
                type="button"
                onClick={() => setPersonaView('admin')}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs transition-colors ${
                  personaView === 'admin'
                    ? 'bg-foreground text-background font-medium'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <Shield className="size-3.5" />
                {tc('Admin Studio & Radar')}
              </button>
            </div>
          ) : undefined
        }
      />

      {hasAdminAccess && personaView === 'admin' ? (
        <AdminCustomerAiPanel />
      ) : (
        <>
          {/* Category Filters & Quick Key Target */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Assistant categories">
              <button
                type="button"
                onClick={() => setCategory('all')}
                className={`rounded-lg px-3 py-1.5 text-xs transition-colors ${
                  category === 'all'
                    ? 'bg-foreground text-background font-medium'
                    : 'border text-muted-foreground hover:text-foreground'
                }`}
              >
                {tc('All')}
              </button>
              {ASSISTANT_CATEGORIES.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setCategory(cat)}
                  className={`rounded-lg px-3 py-1.5 text-xs transition-colors ${
                    category === cat
                      ? 'bg-foreground text-background font-medium'
                      : 'border text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {tc(CATEGORY_LABELS[cat])}
                </button>
              ))}
            </div>

            {!guestMode && activeKeys.length > 0 && (
              <div className="flex items-center gap-2 text-xs">
                <KeyRound className="size-3.5 text-muted-foreground" />
                <span className="text-muted-foreground">{tc('Bind target key:')}</span>
                <select
                  aria-label={tc('Target personal key')}
                  value={effectiveBindKeyId}
                  onChange={(e) => setSelectedBindKeyId(e.target.value)}
                  className="h-8 rounded-lg border bg-background px-2 text-xs"
                >
                  {activeKeys.map(k => (
                    <option key={k.id} value={String(k.id)}>{k.name}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* Assistants Catalog Grid */}
          {catalogLoading ? (
            <div className="rounded-2xl border bg-card p-8 text-center text-sm text-muted-foreground">
              {tc('Loading AI assistants…')}
            </div>
          ) : visibleAssistants.length === 0 ? (
            <div className="rounded-2xl border bg-card p-8 text-center text-sm text-muted-foreground">
              {tc('No published AI assistants match this filter yet.')}
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {visibleAssistants.map((assistant) => (
                <div
                  key={assistant.id}
                  className="rounded-2xl border bg-card p-5 flex flex-col justify-between gap-4 shadow-sm"
                >
                  <div className="space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <Bot className="size-4 text-primary shrink-0" />
                        <h2 className="text-sm font-semibold truncate">{assistant.name}</h2>
                      </div>
                      <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium shrink-0">
                        {assistant.recommendedRoutingMode === 'eco' && <Leaf className="size-3 text-emerald-600" />}
                        {tc(MODE_BADGES[assistant.recommendedRoutingMode])}
                      </span>
                    </div>

                    <p className="text-xs text-muted-foreground">{assistant.description}</p>

                    {assistant.starterPrompts.length > 0 && (
                      <div className="space-y-1">
                        <div className="text-[11px] font-medium text-muted-foreground">
                          {tc('Sample prompts')}
                        </div>
                        <ul className="space-y-1">
                          {assistant.starterPrompts.slice(0, 2).map((sp, i) => (
                            <li
                              key={i}
                              className="text-xs text-muted-foreground bg-muted/40 rounded-lg px-2.5 py-1.5 line-clamp-1"
                            >
                              {sp}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t">
                    <span className="text-[11px] text-muted-foreground">
                      {tc('{keys} key(s) · {chats} chats', {
                        keys: assistant.boundKeysCount,
                        chats: assistant.playgroundRuns,
                      })}
                    </span>
                    <div className="flex items-center gap-2">
                      {!guestMode && activeKeys.length > 0 && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={bindKeyMutation.isPending}
                          onClick={() => {
                            const keyId = Number(effectiveBindKeyId || activeKeys[0]!.id);
                            if (keyId > 0) bindKeyMutation.mutate({ keyId, assistant });
                          }}
                        >
                          <KeyRound className="size-3.5 mr-1" />
                          {tc('Bind to Key')}
                        </Button>
                      )}
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => {
                          if (guestMode) {
                            askToSignIn();
                          } else {
                            setActiveAssistant(assistant);
                          }
                        }}
                      >
                        <MessageSquare className="size-3.5 mr-1" />
                        {guestMode ? tc('Sign in to chat') : tc('Chat Now')}
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Signed-in Customer Personalization & Quota Coach */}
          {!guestMode && (
            <div className="grid gap-6 lg:grid-cols-2">
              <div className="rounded-2xl border bg-card p-5 space-y-4 shadow-sm" aria-label="Custom instructions">
                <div className="flex items-center gap-2">
                  <SlidersHorizontal className="size-4 text-primary" />
                  <h2 className="text-sm font-semibold">{tc('Personal Custom Instructions')}</h2>
                </div>
                <p className="text-xs text-muted-foreground">
                  {tc('Set your preferred language, stack, or formatting style. When enabled, it automatically complements any AI Assistant preset bound to your personal keys.')}
                </p>
                <Textarea
                  value={instructions}
                  onChange={(e) => setDraftPrefs({ customInstructions: e.target.value, applyToKeys })}
                  maxLength={2000}
                  rows={4}
                  placeholder={tc('e.g. Always reply in concise Vietnamese with TypeScript examples.')}
                  className="text-xs"
                />
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={applyToKeys}
                      onChange={(e) => setDraftPrefs({ customInstructions: instructions, applyToKeys: e.target.checked })}
                    />
                    <span>{tc('Apply to my personal API keys')}</span>
                  </label>
                  <Button
                    type="button"
                    size="sm"
                    disabled={savePrefs.isPending || !prefsDirty}
                    onClick={() => savePrefs.mutate()}
                  >
                    {savePrefs.isPending ? tc('Saving…') : tc('Save Instructions')}
                  </Button>
                </div>
              </div>

              <QuotaCoachCard />
            </div>
          )}
        </>
      )}

      {!guestMode && (
        <AssistantChatDrawer
          assistant={activeAssistant}
          onClose={() => setActiveAssistant(null)}
        />
      )}
    </div>
  );
}
