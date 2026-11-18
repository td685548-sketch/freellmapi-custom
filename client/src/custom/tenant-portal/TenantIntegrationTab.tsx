import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Code2, Copy, KeyRound, Plus, RefreshCw, Save, Trash2, Webhook } from 'lucide-react';
import { ConfirmButton } from '@/components/confirm-button';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/lib/toast';
import { tenantPermissionGranted, type TenantPermission } from '../../../../shared/tenant-rbac';
import { useCustomT } from '../i18n/use-custom-t';
import { tenantPortalApi } from './api';

export function TenantIntegrationTab({
  tenantId,
  permissions,
}: {
  tenantId: number;
  permissions: readonly TenantPermission[];
}) {
  const tc = useCustomT();
  const queryClient = useQueryClient();
  const canEdit = tenantPermissionGranted(permissions, 'edit_tenant_integration');
  const canRotate = tenantPermissionGranted(permissions, 'rotate_tenant_secret');

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['tenant-portal-integration', tenantId],
    queryFn: () => tenantPortalApi.getIntegration(tenantId),
  });

  const [originsDraft, setOriginsDraft] = useState<string | null>(null);
  const [maxCompletionDraft, setMaxCompletionDraft] = useState<string | null>(null);
  const [maxToolCallsDraft, setMaxToolCallsDraft] = useState<string | null>(null);
  const [rotatedSecret, setRotatedSecret] = useState<string | null>(null);
  const [whName, setWhName] = useState('');
  const [whUrl, setWhUrl] = useState('');
  const [whEvents, setWhEvents] = useState('ticket.created, csat.submitted');

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['tenant-portal-integration', tenantId] });
  };

  const saveIntegrationMutation = useMutation({
    mutationFn: () => {
      const origins = (originsDraft ?? (data?.allowedOrigins ?? []).join('\n'))
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      return tenantPortalApi.updateIntegration(tenantId, {
        allowedOrigins: origins,
        runtimePolicy: {
          maxCompletionTokens: Number(maxCompletionDraft ?? data?.runtimePolicy.maxCompletionTokens ?? 512),
          maxToolCalls: Number(maxToolCallsDraft ?? data?.runtimePolicy.maxToolCalls ?? 3),
        },
      });
    },
    onSuccess: () => {
      toast.success(tc('Integration settings saved'));
      setOriginsDraft(null);
      setMaxCompletionDraft(null);
      setMaxToolCallsDraft(null);
      refresh();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const rotateMutation = useMutation({
    mutationFn: () => tenantPortalApi.rotateSecret(tenantId),
    onSuccess: (res) => {
      setRotatedSecret(res.signingSecret);
      toast.success(tc('Signing secret rotated'));
      refresh();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const addWebhookMutation = useMutation({
    mutationFn: () =>
      tenantPortalApi.upsertWebhook(tenantId, {
        name: whName.trim(),
        targetUrl: whUrl.trim(),
        events: whEvents
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        enabled: true,
      }),
    onSuccess: () => {
      toast.success(tc('Partner webhook saved'));
      setWhName('');
      setWhUrl('');
      refresh();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteWebhookMutation = useMutation({
    mutationFn: (webhookId: string) => tenantPortalApi.deleteWebhook(tenantId, webhookId),
    onSuccess: () => {
      toast.success(tc('Partner webhook deleted'));
      refresh();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const copyText = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(tc('Copied {label}', { label }));
    } catch {
      toast.error(tc('Copy failed'));
    }
  };

  if (isLoading) {
    return <p className="py-8 text-center text-sm text-muted-foreground">{tc('Loading integration details…')}</p>;
  }
  if (isError || !data) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {error instanceof Error ? error.message : tc('Could not load integration details.')}
      </p>
    );
  }

  const effOrigins = originsDraft ?? data.allowedOrigins.join('\n');
  const effMaxCompletion = maxCompletionDraft ?? String(data.runtimePolicy.maxCompletionTokens);
  const effMaxToolCalls = maxToolCallsDraft ?? String(data.runtimePolicy.maxToolCalls);

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="size-4" />
            {tc('Keys & Embed Snippet')}
          </CardTitle>
          <CardDescription>
            {tc('Public widget credentials, CORS allowed origins, and runtime bounds.')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2 rounded-2xl border bg-muted/20 p-3 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">{tc('Public key')}</span>
              <div className="flex items-center gap-2">
                <code className="font-mono">{data.publicKey}</code>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  onClick={() => void copyText(data.publicKey, 'publicKey')}
                  aria-label="Copy public key"
                >
                  <Copy className="size-3.5" />
                </Button>
              </div>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">{tc('Signing secret')}</span>
              <div className="flex items-center gap-2">
                <code className="font-mono">{data.signingSecretMasked}</code>
                {canRotate && (
                  <ConfirmButton
                    size="xs"
                    variant="outline"
                    confirmLabel={tc('Confirm rotate')}
                    disabled={rotateMutation.isPending}
                    onConfirm={() => rotateMutation.mutate()}
                  >
                    <RefreshCw className="size-3" />
                    {tc('Rotate secret')}
                  </ConfirmButton>
                )}
              </div>
            </div>
          </div>

          {rotatedSecret && (
            <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs space-y-1.5">
              <div className="font-semibold">
                {tc('New signing secret (shown once — save it immediately)')}
              </div>
              <div className="flex items-center justify-between gap-2">
                <code className="font-mono break-all">{rotatedSecret}</code>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={() => void copyText(rotatedSecret, 'signingSecret')}
                >
                  <Copy className="size-3" />
                  {tc('Copy')}
                </Button>
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-xs font-medium">
                <Code2 className="size-3.5" />
                {tc('Website embed code')}
              </span>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => void copyText(data.embedSnippet, 'embedSnippet')}
              >
                <Copy className="size-3" />
                {tc('Copy snippet')}
              </Button>
            </div>
            <pre className="overflow-x-auto rounded-xl border bg-muted/30 p-2.5 text-[11px] font-mono">
              {data.embedSnippet}
            </pre>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="cors-origins" className="text-xs font-medium">
              {tc('Allowed CORS origins (one per line)')}
            </label>
            <Textarea
              id="cors-origins"
              rows={3}
              disabled={!canEdit}
              value={effOrigins}
              onChange={(e) => setOriginsDraft(e.target.value)}
              placeholder="https://support.example.com"
              className="text-xs font-mono"
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <label htmlFor="rt-max-comp" className="text-xs font-medium">
                {tc('Max completion tokens')}
              </label>
              <Input
                id="rt-max-comp"
                type="number"
                disabled={!canEdit}
                value={effMaxCompletion}
                onChange={(e) => setMaxCompletionDraft(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="rt-max-tools" className="text-xs font-medium">
                {tc('Max tool calls per turn')}
              </label>
              <Input
                id="rt-max-tools"
                type="number"
                disabled={!canEdit}
                value={effMaxToolCalls}
                onChange={(e) => setMaxToolCallsDraft(e.target.value)}
              />
            </div>
          </div>

          {canEdit && (
            <div className="flex justify-end border-t pt-3">
              <Button
                type="button"
                size="sm"
                disabled={saveIntegrationMutation.isPending}
                onClick={() => saveIntegrationMutation.mutate()}
              >
                <Save className="size-3.5" />
                {tc('Save Integration Settings')}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Webhook className="size-4" />
            {tc('Outbound Event Webhooks ({count})', { count: data.webhooks.length })}
          </CardTitle>
          <CardDescription>
            {tc('Receive signed HTTP notifications on ticket creation, CSAT ratings, and guardrail blocks.')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {data.webhooks.length === 0 ? (
            <p className="rounded-xl border bg-muted/20 p-4 text-center text-xs text-muted-foreground">
              {tc('No outbound webhooks configured yet.')}
            </p>
          ) : (
            <div className="divide-y rounded-2xl border">
              {data.webhooks.map((wh) => (
                <div key={wh.id} className="flex items-start justify-between gap-2 p-3 text-xs">
                  <div className="min-w-0 space-y-1">
                    <div className="font-semibold">{wh.name}</div>
                    <div className="truncate font-mono text-muted-foreground">{wh.targetUrl}</div>
                    <div className="text-[11px] text-muted-foreground">{wh.events.join(', ')}</div>
                  </div>
                  {canEdit && (
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      className="text-destructive shrink-0"
                      onClick={() => deleteWebhookMutation.mutate(wh.id)}
                      aria-label={`Delete ${wh.name}`}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}

          {canEdit && (
            <div className="space-y-2.5 rounded-2xl border bg-muted/15 p-3">
              <div className="text-xs font-semibold">{tc('Add outbound webhook')}</div>
              <Input
                value={whName}
                onChange={(e) => setWhName(e.target.value)}
                placeholder="CRM Sync"
                className="h-8 text-xs"
              />
              <Input
                value={whUrl}
                onChange={(e) => setWhUrl(e.target.value)}
                placeholder="https://crm.example.com/webhooks/support"
                className="h-8 text-xs"
              />
              <Input
                value={whEvents}
                onChange={(e) => setWhEvents(e.target.value)}
                placeholder="ticket.created, ticket.resolved, csat.submitted"
                className="h-8 text-xs font-mono"
              />
              <Button
                type="button"
                size="sm"
                disabled={addWebhookMutation.isPending || !whName.trim() || !whUrl.trim()}
                onClick={() => addWebhookMutation.mutate()}
              >
                <Plus className="size-3.5" />
                {tc('Add Webhook')}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
