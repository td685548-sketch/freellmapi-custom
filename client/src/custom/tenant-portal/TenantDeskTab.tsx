import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Headphones, MessageSquare, Save, Send, Sliders, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/lib/toast';
import type { SupportDeskWidgetAppearance } from '../../../../shared/support-service-desk';
import { tenantPermissionGranted, type TenantPermission } from '../../../../shared/tenant-rbac';
import { useCustomT } from '../i18n/use-custom-t';
import { tenantPortalApi } from './api';

export function TenantDeskTab({
  tenantId,
  permissions,
}: {
  tenantId: number;
  permissions: readonly TenantPermission[];
}) {
  const tc = useCustomT();
  const queryClient = useQueryClient();
  const canReply = tenantPermissionGranted(permissions, 'reply_tenant_desk');
  const canEditWidget = tenantPermissionGranted(permissions, 'edit_tenant_widget');

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['tenant-portal-desk', tenantId],
    queryFn: () => tenantPortalApi.getDesk(tenantId),
  });

  const [selectedConvId, setSelectedConvId] = useState<string>('');
  const [replyText, setReplyText] = useState('');
  const [resolveOnReply, setResolveOnReply] = useState(false);

  const [widgetEnabledDraft, setWidgetEnabledDraft] = useState<boolean | null>(null);
  const [widgetTitleDraft, setWidgetTitleDraft] = useState<string | null>(null);
  const [widgetWelcomeDraft, setWidgetWelcomeDraft] = useState<string | null>(null);
  const [widgetColorDraft, setWidgetColorDraft] = useState<string | null>(null);
  const [slaEnabledDraft, setSlaEnabledDraft] = useState<boolean | null>(null);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['tenant-portal-desk', tenantId] });
  };

  const replyMutation = useMutation({
    mutationFn: (convId: string) =>
      tenantPortalApi.replyConversation(tenantId, convId, {
        content: replyText.trim(),
        resolveConversation: resolveOnReply,
      }),
    onSuccess: () => {
      toast.success(tc('Reply sent'));
      setReplyText('');
      refresh();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const ticketMutation = useMutation({
    mutationFn: ({ ticketId, status }: { ticketId: string; status: 'open' | 'in_progress' | 'resolved' | 'closed' }) =>
      tenantPortalApi.updateTicket(tenantId, ticketId, { status }),
    onSuccess: () => {
      toast.success(tc('Ticket updated'));
      refresh();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const reviewActionMutation = useMutation({
    mutationFn: ({ actionId, decision }: { actionId: string; decision: 'approved' | 'rejected' }) =>
      tenantPortalApi.reviewAction(tenantId, actionId, { decision }),
    onSuccess: () => {
      toast.success(tc('Action reviewed'));
      refresh();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const widgetMutation = useMutation({
    mutationFn: () => {
      const cfg = data?.widgetConfig;
      if (!cfg) throw new Error('Widget config unavailable');
      const appearance: SupportDeskWidgetAppearance = {
        ...cfg.appearance,
        title: (widgetTitleDraft ?? cfg.appearance.title).trim() || cfg.appearance.title,
        welcomeMessage: widgetWelcomeDraft ?? cfg.appearance.welcomeMessage,
        primaryColor: widgetColorDraft ?? cfg.appearance.primaryColor,
      };
      return tenantPortalApi.updateWidgetConfig(tenantId, {
        expectedVersion: cfg.version,
        enabled: widgetEnabledDraft ?? cfg.enabled,
        appearance,
      });
    },
    onSuccess: () => {
      toast.success(tc('Widget settings saved'));
      setWidgetEnabledDraft(null);
      setWidgetTitleDraft(null);
      setWidgetWelcomeDraft(null);
      setWidgetColorDraft(null);
      refresh();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const slaMutation = useMutation({
    mutationFn: (enabled: boolean) => {
      const sla = data?.slaPolicy;
      if (!sla) throw new Error('SLA policy unavailable');
      return tenantPortalApi.updateSlaPolicy(tenantId, {
        expectedVersion: sla.version,
        enabled,
      });
    },
    onSuccess: () => {
      toast.success(tc('SLA policy updated'));
      setSlaEnabledDraft(null);
      refresh();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  if (isLoading) {
    return <p className="py-8 text-center text-sm text-muted-foreground">{tc('Loading widget & service desk…')}</p>;
  }
  if (isError || !data) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {error instanceof Error ? error.message : tc('Could not load service desk.')}
      </p>
    );
  }

  const conversations = data.conversations;
  const activeConv =
    conversations.find((c) => c.id === selectedConvId) ?? conversations[0] ?? null;

  const effWidgetEnabled = widgetEnabledDraft ?? data.widgetConfig.enabled;
  const effWidgetTitle = widgetTitleDraft ?? data.widgetConfig.appearance.title;
  const effWidgetWelcome = widgetWelcomeDraft ?? data.widgetConfig.appearance.welcomeMessage;
  const effWidgetColor = widgetColorDraft ?? data.widgetConfig.appearance.primaryColor;
  const effSlaEnabled = slaEnabledDraft ?? data.slaPolicy.enabled;

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MessageSquare className="size-4" />
              {tc('Customer Conversations ({count})', { count: conversations.length })}
            </CardTitle>
            <CardDescription>
              {tc('Review recent customer threads and intervene with human agent replies.')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {conversations.length === 0 ? (
              <p className="rounded-xl border bg-muted/20 p-4 text-center text-xs text-muted-foreground">
                {tc('No conversations yet.')}
              </p>
            ) : (
              <>
                <div className="flex flex-wrap gap-1.5">
                  {conversations.slice(0, 8).map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setSelectedConvId(c.id)}
                      className={`rounded-lg border px-2.5 py-1 text-xs ${
                        activeConv?.id === c.id
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'hover:bg-muted/50'
                      }`}
                    >
                      {c.userName || c.userId} · {c.status}
                    </button>
                  ))}
                </div>
                {activeConv && (
                  <div className="space-y-3 rounded-2xl border p-3">
                    <div className="max-h-52 space-y-2 overflow-y-auto text-xs">
                      {activeConv.messages.map((m) => (
                        <div key={m.id} className="rounded-xl bg-muted/30 p-2">
                          <div className="text-[10px] font-semibold text-muted-foreground">
                            {m.senderName || m.senderType}
                          </div>
                          <div className="whitespace-pre-wrap">{m.content}</div>
                        </div>
                      ))}
                    </div>
                    {canReply && (
                      <div className="space-y-2 border-t pt-2">
                        <div className="flex gap-2">
                          <Input
                            value={replyText}
                            onChange={(e) => setReplyText(e.target.value)}
                            placeholder={tc('Write human agent reply…')}
                            className="h-8 text-xs"
                          />
                          <Button
                            type="button"
                            size="sm"
                            disabled={replyMutation.isPending || !replyText.trim()}
                            onClick={() => replyMutation.mutate(activeConv.id)}
                          >
                            <Send className="size-3.5" />
                            {tc('Send')}
                          </Button>
                        </div>
                        <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
                          <input
                            type="checkbox"
                            checked={resolveOnReply}
                            onChange={(e) => setResolveOnReply(e.target.checked)}
                          />
                          <span>{tc('Mark conversation as resolved')}</span>
                        </label>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Headphones className="size-4" />
              {tc('Tickets & Action Approvals')}
            </CardTitle>
            <CardDescription>
              {tc('Triage escalated tickets and approve or reject sensitive AI tool proposals.')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <div className="text-xs font-semibold">
                {tc('Escalation Tickets ({count})', { count: data.tickets.length })}
              </div>
              {data.tickets.length === 0 ? (
                <p className="text-xs text-muted-foreground">{tc('No escalation tickets.')}</p>
              ) : (
                <div className="divide-y rounded-xl border">
                  {data.tickets.slice(0, 6).map((t) => (
                    <div key={t.id} className="flex items-center justify-between gap-2 p-2.5 text-xs">
                      <div className="min-w-0">
                        <div className="font-medium truncate">{t.subject}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {t.priority} · {t.status}
                        </div>
                      </div>
                      {canReply && (
                        <select
                          aria-label={`Status for ${t.subject}`}
                          value={t.status}
                          onChange={(e) =>
                            ticketMutation.mutate({
                              ticketId: t.id,
                              status: e.target.value as 'open' | 'in_progress' | 'resolved' | 'closed',
                            })
                          }
                          className="h-7 rounded-md border bg-background px-2 text-xs"
                        >
                          <option value="open">open</option>
                          <option value="in_progress">in_progress</option>
                          <option value="resolved">resolved</option>
                          <option value="closed">closed</option>
                        </select>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-2 border-t pt-3">
              <div className="text-xs font-semibold">
                {tc('Pending AI Actions ({count})', { count: data.pendingActions.length })}
              </div>
              {data.pendingActions.length === 0 ? (
                <p className="text-xs text-muted-foreground">{tc('No pending actions.')}</p>
              ) : (
                <div className="divide-y rounded-xl border">
                  {data.pendingActions.slice(0, 6).map((act) => (
                    <div key={act.id} className="flex items-center justify-between gap-2 p-2.5 text-xs">
                      <div className="min-w-0">
                        <div className="font-medium font-mono truncate">{act.toolName}</div>
                        <div className="text-[11px] text-muted-foreground truncate">
                          {act.actionSummary} · {act.status}
                        </div>
                      </div>
                      {canReply && act.status === 'pending' && (
                        <div className="flex gap-1 shrink-0">
                          <Button
                            type="button"
                            size="icon-xs"
                            variant="outline"
                            onClick={() =>
                              reviewActionMutation.mutate({ actionId: act.id, decision: 'approved' })
                            }
                            aria-label={`Approve ${act.toolName}`}
                          >
                            <Check className="size-3.5 text-emerald-600" />
                          </Button>
                          <Button
                            type="button"
                            size="icon-xs"
                            variant="outline"
                            onClick={() =>
                              reviewActionMutation.mutate({ actionId: act.id, decision: 'rejected' })
                            }
                            aria-label={`Reject ${act.toolName}`}
                          >
                            <X className="size-3.5 text-destructive" />
                          </Button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sliders className="size-4" />
            {tc('Embeddable Widget & SLA Settings')}
          </CardTitle>
          <CardDescription>
            {tc('Customize widget branding, greeting, and SLA tracking for your website.')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-6 rounded-2xl border bg-muted/20 p-3">
            <label className="flex items-center gap-2 text-xs font-medium">
              <Switch
                checked={effWidgetEnabled}
                disabled={!canEditWidget}
                onCheckedChange={(c) => setWidgetEnabledDraft(Boolean(c))}
              />
              <span>{tc('Enable embeddable widget')}</span>
            </label>
            <label className="flex items-center gap-2 text-xs font-medium">
              <Switch
                checked={effSlaEnabled}
                disabled={!canEditWidget || slaMutation.isPending}
                onCheckedChange={(c) => {
                  setSlaEnabledDraft(Boolean(c));
                  slaMutation.mutate(Boolean(c));
                }}
              />
              <span>{tc('Enable SLA tracking')}</span>
            </label>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1">
              <label htmlFor="widget-title" className="text-xs font-medium">
                {tc('Widget title')}
              </label>
              <Input
                id="widget-title"
                disabled={!canEditWidget}
                value={effWidgetTitle}
                onChange={(e) => setWidgetTitleDraft(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="widget-color" className="text-xs font-medium">
                {tc('Primary accent color')}
              </label>
              <Input
                id="widget-color"
                disabled={!canEditWidget}
                value={effWidgetColor}
                onChange={(e) => setWidgetColorDraft(e.target.value)}
                className="font-mono"
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="widget-welcome" className="text-xs font-medium">
                {tc('Welcome message')}
              </label>
              <Input
                id="widget-welcome"
                disabled={!canEditWidget}
                value={effWidgetWelcome}
                onChange={(e) => setWidgetWelcomeDraft(e.target.value)}
              />
            </div>
          </div>

          {canEditWidget && (
            <div className="flex justify-end border-t pt-3">
              <Button
                type="button"
                size="sm"
                disabled={widgetMutation.isPending}
                onClick={() => widgetMutation.mutate()}
              >
                <Save className="size-3.5" />
                {tc('Save Widget Settings')}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
