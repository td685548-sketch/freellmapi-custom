import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, Save, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/lib/toast';
import type { SupportOutputMode } from '../../../../shared/support-output';
import { tenantPermissionGranted, type TenantPermission } from '../../../../shared/tenant-rbac';
import { useCustomT } from '../i18n/use-custom-t';
import { tenantPortalApi } from './api';

export function TenantGuardrailsTab({
  tenantId,
  permissions,
}: {
  tenantId: number;
  permissions: readonly TenantPermission[];
}) {
  const tc = useCustomT();
  const queryClient = useQueryClient();
  const canEdit = tenantPermissionGranted(permissions, 'edit_tenant_guardrails');

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['tenant-portal-guardrails', tenantId],
    queryFn: () => tenantPortalApi.getGuardrails(tenantId),
  });

  const [blockedTopicsDraft, setBlockedTopicsDraft] = useState<string | null>(null);
  const [maxInputDraft, setMaxInputDraft] = useState<string | null>(null);
  const [firewallEnabledDraft, setFirewallEnabledDraft] = useState<boolean | null>(null);
  const [blockInjectionDraft, setBlockInjectionDraft] = useState<boolean | null>(null);
  const [evalText, setEvalText] = useState('');
  const [evalResult, setEvalResult] = useState<string | null>(null);

  const [outModeDraft, setOutModeDraft] = useState<SupportOutputMode | null>(null);
  const [outMaxCharsDraft, setOutMaxCharsDraft] = useState<string | null>(null);
  const [outRedactDraft, setOutRedactDraft] = useState<boolean | null>(null);
  const [outTermsDraft, setOutTermsDraft] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState('');
  const [previewResult, setPreviewResult] = useState<string | null>(null);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['tenant-portal-guardrails', tenantId] });
  };

  const guardrails = data?.guardrails;
  const outputPolicy = data?.outputPolicy;
  const outputEvents = data?.outputEvents ?? [];

  const effFirewallEnabled = firewallEnabledDraft ?? guardrails?.enabled ?? true;
  const effBlockInjection = blockInjectionDraft ?? guardrails?.blockPromptInjection ?? true;
  const effMaxInput = maxInputDraft ?? String(guardrails?.maxInputLength ?? 4000);
  const effTopics = blockedTopicsDraft ?? (guardrails?.blockedTopics ?? []).join('\n');

  const effOutMode = outModeDraft ?? outputPolicy?.mode ?? 'off';
  const effOutMaxChars = outMaxCharsDraft ?? String(outputPolicy?.maxOutputChars ?? 16000);
  const effOutRedact = outRedactDraft ?? outputPolicy?.redactCredentials ?? false;
  const effOutTerms =
    outTermsDraft ?? (outputPolicy?.blockedTerms ?? []).map((t) => t.text).join('\n');

  const buildOutputRules = () =>
    effOutTerms
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 50)
      .map((text, idx) => ({ id: `rule_${idx + 1}`, text }));

  const saveGuardrailsMutation = useMutation({
    mutationFn: () =>
      tenantPortalApi.updateGuardrails(tenantId, {
        enabled: effFirewallEnabled,
        blockPromptInjection: effBlockInjection,
        maxInputLength: Number(effMaxInput) || 4000,
        blockedTopics: effTopics
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
      }),
    onSuccess: () => {
      toast.success(tc('Input guardrails saved'));
      setFirewallEnabledDraft(null);
      setBlockInjectionDraft(null);
      setMaxInputDraft(null);
      setBlockedTopicsDraft(null);
      refresh();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const evalMutation = useMutation({
    mutationFn: () =>
      tenantPortalApi.evaluateGuardrails(tenantId, { text: evalText, role: 'customer' }),
    onSuccess: (res) => {
      setEvalResult(
        res.evaluation.allowed
          ? tc('Allowed (no rule triggered)')
          : tc('Blocked: {reason}', { reason: res.evaluation.blockedReason ?? 'policy' }),
      );
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const saveOutputMutation = useMutation({
    mutationFn: () =>
      tenantPortalApi.saveOutputPolicy(tenantId, {
        expectedVersion: outputPolicy?.version ?? 0,
        policy: {
          mode: effOutMode,
          maxOutputChars: Number(effOutMaxChars) || 16000,
          redactCredentials: effOutRedact,
          blockedTerms: buildOutputRules(),
        },
      }),
    onSuccess: () => {
      toast.success(tc('Output control policy saved'));
      setOutModeDraft(null);
      setOutMaxCharsDraft(null);
      setOutRedactDraft(null);
      setOutTermsDraft(null);
      refresh();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const previewOutputMutation = useMutation({
    mutationFn: () =>
      tenantPortalApi.previewOutputPolicy(tenantId, {
        policy: {
          mode: effOutMode,
          maxOutputChars: Number(effOutMaxChars) || 16000,
          redactCredentials: effOutRedact,
          blockedTerms: buildOutputRules(),
        },
        text: previewText,
      }),
    onSuccess: (res) => {
      const reply = res.decision.leaves[0]?.text ?? '';
      setPreviewResult(`[${res.decision.action}] ${reply}`);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  if (isLoading) {
    return <p className="py-8 text-center text-sm text-muted-foreground">{tc('Loading guardrails & output controls…')}</p>;
  }
  if (isError || !guardrails || !outputPolicy) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {error instanceof Error ? error.message : tc('Could not load guardrails.')}
      </p>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldAlert className="size-4" />
            {tc('Input Guardrails & Firewall')}
          </CardTitle>
          <CardDescription>
            {tc('Protect against prompt injection, oversized inputs, and off-limit topics.')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-6 rounded-2xl border bg-muted/20 p-3">
            <label className="flex items-center gap-2 text-xs font-medium">
              <Switch
                checked={effFirewallEnabled}
                disabled={!canEdit}
                onCheckedChange={(c) => setFirewallEnabledDraft(Boolean(c))}
              />
              <span>{tc('Enable input guardrails')}</span>
            </label>
            <label className="flex items-center gap-2 text-xs font-medium">
              <Switch
                checked={effBlockInjection}
                disabled={!canEdit}
                onCheckedChange={(c) => setBlockInjectionDraft(Boolean(c))}
              />
              <span>{tc('Block prompt injection')}</span>
            </label>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="guard-max-len" className="text-xs font-medium">
              {tc('Max input characters')}
            </label>
            <Input
              id="guard-max-len"
              type="number"
              disabled={!canEdit}
              value={effMaxInput}
              onChange={(e) => setMaxInputDraft(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="guard-topics" className="text-xs font-medium">
              {tc('Blocked topic phrases (one per line)')}
            </label>
            <Textarea
              id="guard-topics"
              rows={4}
              disabled={!canEdit}
              value={effTopics}
              onChange={(e) => setBlockedTopicsDraft(e.target.value)}
            />
          </div>

          {canEdit && (
            <Button
              type="button"
              size="sm"
              disabled={saveGuardrailsMutation.isPending}
              onClick={() => saveGuardrailsMutation.mutate()}
            >
              <Save className="size-3.5" />
              {tc('Save Input Guardrails')}
            </Button>
          )}

          <div className="space-y-2 border-t pt-3">
            <div className="text-xs font-medium">{tc('Test input against firewall')}</div>
            <div className="flex gap-2">
              <Input
                value={evalText}
                onChange={(e) => setEvalText(e.target.value)}
                placeholder={tc('Try an injection or blocked term…')}
                className="text-xs"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={evalMutation.isPending || !evalText.trim()}
                onClick={() => evalMutation.mutate()}
              >
                {tc('Evaluate')}
              </Button>
            </div>
            {evalResult && <p className="text-xs font-medium text-muted-foreground">{evalResult}</p>}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Lock className="size-4" />
            {tc('Output Controls & Redaction')}
          </CardTitle>
          <CardDescription>
            {tc('Scan and redact credentials or blocked terms before responses reach customers.')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <label htmlFor="out-mode" className="text-xs font-medium">
                {tc('Enforcement mode')}
              </label>
              <select
                id="out-mode"
                disabled={!canEdit}
                value={effOutMode}
                onChange={(e) => setOutModeDraft(e.target.value as SupportOutputMode)}
                className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"
              >
                <option value="off">off</option>
                <option value="log">log</option>
                <option value="enforce">enforce</option>
              </select>
            </div>
            <div className="space-y-1">
              <label htmlFor="out-max-chars" className="text-xs font-medium">
                {tc('Max output characters')}
              </label>
              <Input
                id="out-max-chars"
                type="number"
                disabled={!canEdit}
                value={effOutMaxChars}
                onChange={(e) => setOutMaxCharsDraft(e.target.value)}
              />
            </div>
          </div>

          <label className="flex items-center gap-2.5 text-xs font-medium">
            <Switch
              checked={effOutRedact}
              disabled={!canEdit}
              onCheckedChange={(c) => setOutRedactDraft(Boolean(c))}
            />
            <span>{tc('Redact API keys & credentials in AI replies')}</span>
          </label>

          <div className="space-y-1.5">
            <label htmlFor="out-terms" className="text-xs font-medium">
              {tc('Blocked output terms (one per line)')}
            </label>
            <Textarea
              id="out-terms"
              rows={3}
              disabled={!canEdit}
              value={effOutTerms}
              onChange={(e) => setOutTermsDraft(e.target.value)}
            />
          </div>

          {canEdit && (
            <Button
              type="button"
              size="sm"
              disabled={saveOutputMutation.isPending}
              onClick={() => saveOutputMutation.mutate()}
            >
              <ShieldCheck className="size-3.5" />
              {tc('Save Output Policy')}
            </Button>
          )}

          <div className="space-y-2 border-t pt-3">
            <div className="text-xs font-medium">{tc('Preview output policy')}</div>
            <div className="flex gap-2">
              <Input
                value={previewText}
                onChange={(e) => setPreviewText(e.target.value)}
                placeholder={tc('Sample AI reply text…')}
                className="text-xs"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={previewOutputMutation.isPending || !previewText}
                onClick={() => previewOutputMutation.mutate()}
              >
                {tc('Preview')}
              </Button>
            </div>
            {previewResult && (
              <p className="rounded-xl bg-muted/30 p-2 text-xs font-mono">{previewResult}</p>
            )}
          </div>

          {outputEvents.length > 0 && (
            <div className="space-y-1.5 border-t pt-3">
              <div className="text-xs font-medium">{tc('Recent output events')}</div>
              <div className="max-h-32 space-y-1 overflow-y-auto text-[11px]">
                {outputEvents.map((ev) => (
                  <div key={ev.id} className="flex justify-between rounded-lg border px-2 py-1">
                    <span className="font-mono">{ev.action}</span>
                    <span className="text-muted-foreground">{ev.reasons.join(', ') || 'clean'}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
