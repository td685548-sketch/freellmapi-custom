import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Plus, Search, Shield, Sparkles, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/lib/toast';
import { tenantPermissionGranted, type TenantPermission } from '../../../../shared/tenant-rbac';
import { useCustomT } from '../i18n/use-custom-t';
import { tenantPortalApi, type SupportBuiltinMaskDetector } from './api';

const DETECTORS: SupportBuiltinMaskDetector[] = ['email', 'phone', 'credit_card', 'api_key'];

export function TenantKnowledgeTab({
  tenantId,
  permissions,
}: {
  tenantId: number;
  permissions: readonly TenantPermission[];
}) {
  const tc = useCustomT();
  const queryClient = useQueryClient();
  const canEdit = tenantPermissionGranted(permissions, 'edit_tenant_knowledge');

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['tenant-portal-knowledge', tenantId],
    queryFn: () => tenantPortalApi.getKnowledge(tenantId),
  });

  const [docTitle, setDocTitle] = useState('');
  const [docCategory, setDocCategory] = useState('faq');
  const [docRoles, setDocRoles] = useState('customer, staff, admin');
  const [docContent, setDocContent] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchRole, setSearchRole] = useState('customer');
  const [searchHits, setSearchHits] = useState<
    Array<{ docId: string; title: string; snippet: string; score: number }>
  >([]);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['tenant-portal-knowledge', tenantId] });
  };

  const addDocMutation = useMutation({
    mutationFn: () =>
      tenantPortalApi.upsertKnowledgeDoc(tenantId, {
        title: docTitle.trim(),
        category: docCategory.trim() || 'faq',
        allowedRoles: docRoles
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        content: docContent,
        enabled: true,
      }),
    onSuccess: () => {
      toast.success(tc('Knowledge document added'));
      setDocTitle('');
      setDocContent('');
      refresh();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const seedMutation = useMutation({
    mutationFn: () => tenantPortalApi.seedKnowledgeDocs(tenantId),
    onSuccess: () => {
      toast.success(tc('Default knowledge articles seeded'));
      refresh();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (docId: string) => tenantPortalApi.deleteKnowledgeDoc(tenantId, docId),
    onSuccess: () => {
      toast.success(tc('Knowledge document deleted'));
      refresh();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const searchMutation = useMutation({
    mutationFn: () =>
      tenantPortalApi.searchKnowledge(tenantId, { query: searchQuery, role: searchRole, topK: 5 }),
    onSuccess: (res) => setSearchHits(res.matches),
    onError: (err: Error) => toast.error(err.message),
  });

  const maskingMutation = useMutation({
    mutationFn: (patch: { enabled?: boolean; builtinDetectors?: SupportBuiltinMaskDetector[] }) =>
      tenantPortalApi.updateMasking(tenantId, patch),
    onSuccess: () => {
      toast.success(tc('Masking policy updated'));
      refresh();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  if (isLoading) {
    return <p className="py-8 text-center text-sm text-muted-foreground">{tc('Loading knowledge base…')}</p>;
  }
  if (isError || !data) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {error instanceof Error ? error.message : tc('Could not load knowledge base.')}
      </p>
    );
  }

  const docs = data.docs;
  const masking = data.masking;

  const toggleDetector = (detector: SupportBuiltinMaskDetector) => {
    const exists = masking.builtinDetectors.includes(detector);
    const next = exists
      ? masking.builtinDetectors.filter((d) => d !== detector)
      : [...masking.builtinDetectors, detector];
    maskingMutation.mutate({ builtinDetectors: next });
  };

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-[1.35fr_1fr]">
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                <BookOpen className="size-4" />
                {tc('Knowledge Documents ({count})', { count: docs.length })}
              </CardTitle>
              <CardDescription>
                {tc('Role-scoped reference articles injected into AI support answers.')}
              </CardDescription>
            </div>
            {canEdit && (
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={seedMutation.isPending}
                onClick={() => seedMutation.mutate()}
              >
                <Sparkles className="size-3.5" />
                {tc('Seed sample docs')}
              </Button>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            {docs.length === 0 ? (
              <p className="rounded-xl border bg-muted/20 p-4 text-center text-xs text-muted-foreground">
                {tc('No knowledge documents yet.')}
              </p>
            ) : (
              <div className="divide-y rounded-2xl border">
                {docs.map((doc) => (
                  <div key={doc.id} className="flex items-start justify-between gap-3 p-3">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-semibold">{doc.title}</span>
                        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px]">
                          {doc.category}
                        </span>
                        <span className="text-[10px] font-mono text-muted-foreground">
                          {doc.allowedRoles.join(', ')}
                        </span>
                      </div>
                      <p className="line-clamp-2 text-xs text-muted-foreground">{doc.content}</p>
                    </div>
                    {canEdit && (
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        className="text-destructive shrink-0"
                        disabled={deleteMutation.isPending}
                        onClick={() => deleteMutation.mutate(doc.id)}
                        aria-label={`Delete ${doc.title}`}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}

            {canEdit && (
              <div className="space-y-3 rounded-2xl border bg-muted/15 p-4">
                <div className="text-xs font-semibold">{tc('Add knowledge article')}</div>
                <div className="grid gap-2 sm:grid-cols-3">
                  <Input
                    value={docTitle}
                    onChange={(e) => setDocTitle(e.target.value)}
                    placeholder={tc('Document title')}
                    className="text-xs"
                  />
                  <Input
                    value={docCategory}
                    onChange={(e) => setDocCategory(e.target.value)}
                    placeholder="faq / policy"
                    className="text-xs"
                  />
                  <Input
                    value={docRoles}
                    onChange={(e) => setDocRoles(e.target.value)}
                    placeholder="customer, staff, admin"
                    className="text-xs font-mono"
                  />
                </div>
                <Textarea
                  rows={4}
                  value={docContent}
                  onChange={(e) => setDocContent(e.target.value)}
                  placeholder={tc('Write markdown or plain-text knowledge content…')}
                />
                <Button
                  type="button"
                  size="sm"
                  disabled={addDocMutation.isPending || !docTitle.trim() || !docContent.trim()}
                  onClick={() => addDocMutation.mutate()}
                >
                  <Plus className="size-3.5" />
                  {tc('Add Document')}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Search className="size-4" />
                {tc('Test RAG Retrieval')}
              </CardTitle>
              <CardDescription>
                {tc('Preview which excerpts match a user query under a specific role.')}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex gap-2">
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={tc('Search query…')}
                  className="text-xs"
                />
                <Input
                  value={searchRole}
                  onChange={(e) => setSearchRole(e.target.value)}
                  placeholder="customer"
                  className="w-28 text-xs font-mono"
                />
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={searchMutation.isPending || !searchQuery.trim()}
                onClick={() => searchMutation.mutate()}
              >
                <Search className="size-3.5" />
                {tc('Run Search')}
              </Button>
              {searchHits.length > 0 && (
                <div className="space-y-2 pt-2">
                  {searchHits.map((hit) => (
                    <div key={hit.docId} className="rounded-xl border p-2.5 text-xs">
                      <div className="font-semibold">{hit.title}</div>
                      <p className="mt-1 text-muted-foreground">{hit.snippet}</p>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Shield className="size-4" />
                {tc('PII & Sensitive Data Masking')}
              </CardTitle>
              <CardDescription>
                {tc('Automatically redact sensitive values in retrieved knowledge and responses.')}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <label className="flex items-center gap-2.5 text-xs font-medium">
                <Switch
                  checked={masking.enabled}
                  disabled={!canEdit || maskingMutation.isPending}
                  onCheckedChange={(checked) => maskingMutation.mutate({ enabled: Boolean(checked) })}
                />
                <span>{tc('Enable PII masking')}</span>
              </label>
              <div className="grid grid-cols-2 gap-2">
                {DETECTORS.map((detector) => (
                  <label key={detector} className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={masking.builtinDetectors.includes(detector)}
                      disabled={!canEdit || maskingMutation.isPending}
                      onChange={() => toggleDetector(detector)}
                    />
                    <span className="font-mono">{detector}</span>
                  </label>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
