import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Play, Plus, Save, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/lib/toast';
import { tenantPermissionGranted, type TenantPermission } from '../../../../shared/tenant-rbac';
import type { TenantModelOption } from '../../../../shared/tenant-rbac';
import { useCustomT } from '../i18n/use-custom-t';
import { tenantPortalApi, type SupportRoleConfig, type TenantDetail } from './api';

interface TenantAiTabProps {
  tenantId: number;
  permissions: readonly TenantPermission[];
  availableModels: TenantModelOption[];
}

export function TenantAiTab({ tenantId, permissions, availableModels }: TenantAiTabProps) {
  const tc = useCustomT();
  const queryClient = useQueryClient();
  const canEdit = tenantPermissionGranted(permissions, 'edit_tenant_ai');
  const canTest = tenantPermissionGranted(permissions, 'test_tenant_ai');

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['tenant-portal-ai', tenantId],
    queryFn: () => tenantPortalApi.getTenantAi(tenantId),
  });

  const [draft, setDraft] = useState<Partial<TenantDetail> | null>(null);
  const [simRole, setSimRole] = useState('customer');
  const [simUserId, setSimUserId] = useState('demo-user-1');
  const [simMessage, setSimMessage] = useState('');
  const [simReply, setSimReply] = useState<{
    reply: string;
    modelUsed: string | null;
    tokens: number;
  } | null>(null);

  const tenant = data?.tenant;
  const models = data?.availableModels ?? availableModels;

  const effectiveName = draft?.name ?? tenant?.name ?? '';
  const effectiveModel = draft?.defaultModel ?? tenant?.defaultModel ?? 'auto';
  const effectivePrompt = draft?.systemPrompt ?? tenant?.systemPrompt ?? '';
  const effectiveAllowGuest = draft?.allowGuest ?? tenant?.allowGuest ?? true;
  const effectiveEnabled = draft?.enabled ?? tenant?.enabled ?? true;
  const effectiveRoles: SupportRoleConfig[] = draft?.rolesConfig ?? tenant?.rolesConfig ?? [];

  const saveMutation = useMutation({
    mutationFn: () =>
      tenantPortalApi.updateTenantAi(tenantId, {
        name: effectiveName.trim() || tenant?.name || 'Tenant',
        defaultModel: effectiveModel.trim() || 'auto',
        systemPrompt: effectivePrompt,
        allowGuest: effectiveAllowGuest,
        enabled: effectiveEnabled,
        rolesConfig: effectiveRoles,
      }),
    onSuccess: () => {
      toast.success(tc('Tenant AI settings saved'));
      setDraft(null);
      queryClient.invalidateQueries({ queryKey: ['tenant-portal-ai', tenantId] });
      queryClient.invalidateQueries({ queryKey: ['tenant-portal-tenants'] });
    },
    onError: (err: Error) => {
      toast.error(err.message || tc('Failed to save tenant AI settings'));
    },
  });

  const simMutation = useMutation({
    mutationFn: () =>
      tenantPortalApi.simulateChat(tenantId, {
        role: simRole,
        userId: simUserId.trim() || 'demo-user-1',
        model: effectiveModel.trim() || undefined,
        messages: [{ role: 'user', content: simMessage.trim() }],
      }),
    onSuccess: (res) => {
      setSimReply({
        reply: res.reply,
        modelUsed: res.modelUsed,
        tokens: res.usage?.total_tokens ?? 0,
      });
    },
    onError: (err: Error) => {
      toast.error(err.message || tc('Sandbox chat failed'));
    },
  });

  if (isLoading) {
    return <p className="py-8 text-center text-sm text-muted-foreground">{tc('Loading AI configuration…')}</p>;
  }
  if (isError || !tenant) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {error instanceof Error ? error.message : tc('Could not load tenant AI settings.')}
      </p>
    );
  }

  const updateField = <K extends keyof TenantDetail>(key: K, value: TenantDetail[K]) => {
    setDraft((prev) => ({ ...(prev ?? {}), [key]: value }));
  };

  const addRole = () => {
    const nextRole = `role_${effectiveRoles.length + 1}`;
    updateField('rolesConfig', [
      ...effectiveRoles,
      { role: nextRole, label: nextRole, permissions: ['products:read'] },
    ]);
  };

  const updateRole = (idx: number, patch: Partial<SupportRoleConfig>) => {
    const next = effectiveRoles.map((r, i) => (i === idx ? { ...r, ...patch } : r));
    updateField('rolesConfig', next);
  };

  const removeRole = (idx: number) => {
    updateField(
      'rolesConfig',
      effectiveRoles.filter((_, i) => i !== idx),
    );
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1.35fr_1fr]">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bot className="size-4" />
            {tc('AI Behavior & Model')}
          </CardTitle>
          <CardDescription>
            {tc('Adjust how this tenant selects models, behaves via system prompt, and maps end-user roles.')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="tenant-ai-name" className="text-xs font-medium">
                {tc('Tenant display name')}
              </label>
              <Input
                id="tenant-ai-name"
                value={effectiveName}
                disabled={!canEdit}
                onChange={(e) => updateField('name', e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="tenant-ai-model-select" className="text-xs font-medium">
                {tc('Default AI model / combo')}
              </label>
              <select
                id="tenant-ai-model-select"
                disabled={!canEdit}
                value={models.some((m) => m.id === effectiveModel) ? effectiveModel : '__custom__'}
                onChange={(e) => {
                  if (e.target.value !== '__custom__') {
                    updateField('defaultModel', e.target.value);
                  }
                }}
                className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
                {!models.some((m) => m.id === effectiveModel) && (
                  <option value="__custom__">{effectiveModel}</option>
                )}
              </select>
              <Input
                aria-label="Custom model selector"
                value={effectiveModel}
                disabled={!canEdit}
                placeholder="auto"
                onChange={(e) => updateField('defaultModel', e.target.value)}
                className="mt-1.5 text-xs font-mono"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="tenant-system-prompt" className="text-xs font-medium">
              {tc('System prompt instructions')}
            </label>
            <Textarea
              id="tenant-system-prompt"
              rows={6}
              disabled={!canEdit}
              value={effectivePrompt}
              onChange={(e) => updateField('systemPrompt', e.target.value)}
              placeholder={tc('Define persona, tone, escalation rules, and response constraints…')}
            />
          </div>

          <div className="flex flex-wrap gap-6 rounded-2xl border bg-muted/20 p-3">
            <label className="flex items-center gap-2.5 text-xs font-medium">
              <Switch
                checked={effectiveEnabled}
                disabled={!canEdit}
                onCheckedChange={(checked) => updateField('enabled', Boolean(checked))}
              />
              <span>{tc('Tenant active')}</span>
            </label>
            <label className="flex items-center gap-2.5 text-xs font-medium">
              <Switch
                checked={effectiveAllowGuest}
                disabled={!canEdit}
                onCheckedChange={(checked) => updateField('allowGuest', Boolean(checked))}
              />
              <span>{tc('Allow guest sessions')}</span>
            </label>
          </div>

          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs font-semibold">{tc('End-user RBAC roles')}</div>
                <p className="text-[11px] text-muted-foreground">
                  {tc('Controls which tools and RAG documents end-user roles can access.')}
                </p>
              </div>
              {canEdit && (
                <Button type="button" size="xs" variant="outline" onClick={addRole}>
                  <Plus className="size-3.5" />
                  {tc('Add role')}
                </Button>
              )}
            </div>
            <div className="space-y-2">
              {effectiveRoles.map((roleItem, idx) => (
                <div
                  key={`${roleItem.role}-${idx}`}
                  className="grid gap-2 rounded-xl border p-2.5 sm:grid-cols-[120px_130px_1fr_auto]"
                >
                  <Input
                    value={roleItem.role}
                    disabled={!canEdit}
                    aria-label="Role key"
                    placeholder="role"
                    className="h-8 text-xs font-mono"
                    onChange={(e) => updateRole(idx, { role: e.target.value })}
                  />
                  <Input
                    value={roleItem.label}
                    disabled={!canEdit}
                    aria-label="Role label"
                    placeholder="Label"
                    className="h-8 text-xs"
                    onChange={(e) => updateRole(idx, { label: e.target.value })}
                  />
                  <Input
                    value={roleItem.permissions.join(', ')}
                    disabled={!canEdit}
                    aria-label="Role permissions"
                    placeholder="products:read, orders:read_own"
                    className="h-8 text-xs font-mono"
                    onChange={(e) =>
                      updateRole(idx, {
                        permissions: e.target.value
                          .split(',')
                          .map((s) => s.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                  {canEdit && (
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      className="text-destructive"
                      onClick={() => removeRole(idx)}
                      aria-label={`Remove ${roleItem.role}`}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </div>

          {canEdit && (
            <div className="flex justify-end border-t pt-3">
              <Button
                type="button"
                size="sm"
                disabled={saveMutation.isPending}
                onClick={() => saveMutation.mutate()}
              >
                <Save className="size-3.5" />
                {saveMutation.isPending ? tc('Saving…') : tc('Save AI Configuration')}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Play className="size-4" />
            {tc('AI Sandbox Simulator')}
          </CardTitle>
          <CardDescription>
            {tc('Test your tenant prompt, model, and role visibility safely before deploying.')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!canTest ? (
            <p className="rounded-xl border bg-muted/30 p-3 text-xs text-muted-foreground">
              {tc('Sandbox testing requires the test_tenant_ai permission.')}
            </p>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <label htmlFor="sim-role" className="text-xs font-medium">
                    {tc('Simulate as role')}
                  </label>
                  <select
                    id="sim-role"
                    value={simRole}
                    onChange={(e) => setSimRole(e.target.value)}
                    className="h-8 w-full rounded-lg border border-input bg-background px-2.5 text-xs"
                  >
                    {effectiveRoles.map((r) => (
                      <option key={r.role} value={r.role}>
                        {r.label} ({r.role})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <label htmlFor="sim-userid" className="text-xs font-medium">
                    {tc('Simulated user ID')}
                  </label>
                  <Input
                    id="sim-userid"
                    value={simUserId}
                    onChange={(e) => setSimUserId(e.target.value)}
                    className="h-8 text-xs font-mono"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label htmlFor="sim-message" className="text-xs font-medium">
                  {tc('Test prompt')}
                </label>
                <Textarea
                  id="sim-message"
                  rows={3}
                  value={simMessage}
                  onChange={(e) => setSimMessage(e.target.value)}
                  placeholder={tc('Ask a customer support question…')}
                />
              </div>

              <Button
                type="button"
                size="sm"
                disabled={simMutation.isPending || !simMessage.trim()}
                onClick={() => simMutation.mutate()}
              >
                <Play className="size-3.5" />
                {simMutation.isPending ? tc('Running…') : tc('Run Sandbox Test')}
              </Button>

              {simReply && (
                <div className="space-y-2 rounded-2xl border bg-muted/20 p-3 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
                    <span>{tc('Model: {model}', { model: simReply.modelUsed ?? 'auto' })}</span>
                    <span>{tc('Tokens: {tokens}', { tokens: simReply.tokens })}</span>
                  </div>
                  <p className="whitespace-pre-wrap text-foreground">{simReply.reply}</p>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
