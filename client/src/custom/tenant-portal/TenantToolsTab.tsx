import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Database, Play, Plus, Trash2, Webhook } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/lib/toast';
import { tenantPermissionGranted, type TenantPermission } from '../../../../shared/tenant-rbac';
import { useCustomT } from '../i18n/use-custom-t';
import { tenantPortalApi } from './api';

export function TenantToolsTab({
  tenantId,
  permissions,
}: {
  tenantId: number;
  permissions: readonly TenantPermission[];
}) {
  const tc = useCustomT();
  const queryClient = useQueryClient();
  const canEdit = tenantPermissionGranted(permissions, 'edit_tenant_tools');
  const canTest = tenantPermissionGranted(permissions, 'test_tenant_tools');

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['tenant-portal-tools', tenantId],
    queryFn: () => tenantPortalApi.getTools(tenantId),
  });

  const [toolName, setToolName] = useState('');
  const [toolUrl, setToolUrl] = useState('');
  const [toolDesc, setToolDesc] = useState('');
  const [toolRoles, setToolRoles] = useState('customer, staff, admin');
  const [dbName, setDbName] = useState('Sample Store DB');
  const [dbSql, setDbSql] = useState('');
  const [testSql, setTestSql] = useState('SELECT id, name, price FROM products LIMIT 5');
  const [queryOutput, setQueryOutput] = useState<string>('');

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['tenant-portal-tools', tenantId] });
  };

  const createToolMutation = useMutation({
    mutationFn: () =>
      tenantPortalApi.createTool(tenantId, {
        name: toolName.trim(),
        endpointUrl: toolUrl.trim(),
        description: toolDesc.trim(),
        method: 'POST',
        allowedRoles: toolRoles
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        enabled: true,
      }),
    onSuccess: () => {
      toast.success(tc('Webhook tool created'));
      setToolName('');
      setToolUrl('');
      setToolDesc('');
      refresh();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteToolMutation = useMutation({
    mutationFn: (toolId: number) => tenantPortalApi.deleteTool(tenantId, toolId),
    onSuccess: () => {
      toast.success(tc('Webhook tool deleted'));
      refresh();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const createDbMutation = useMutation({
    mutationFn: () =>
      tenantPortalApi.createDbSource(tenantId, {
        name: dbName.trim() || 'Sandbox DB',
        driver: 'sqlite-sandbox',
        schemaSql: dbSql || data?.sampleSchemaSql || '',
        tablePolicies: [
          { tableName: 'products', allowedRoles: ['guest', 'customer', 'staff', 'admin'] },
        ],
        maxRows: 50,
        enabled: true,
      }),
    onSuccess: () => {
      toast.success(tc('Database source created'));
      refresh();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteDbMutation = useMutation({
    mutationFn: (sourceId: number) => tenantPortalApi.deleteDbSource(tenantId, sourceId),
    onSuccess: () => {
      toast.success(tc('Database source deleted'));
      refresh();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const queryDbMutation = useMutation({
    mutationFn: (sourceId: number) =>
      tenantPortalApi.queryDbSource(tenantId, sourceId, {
        userId: 'cust_101',
        role: 'customer',
        sql: testSql,
      }),
    onSuccess: (res) => {
      setQueryOutput(JSON.stringify(res.rows, null, 2));
    },
    onError: (err: Error) => toast.error(err.message),
  });

  if (isLoading) {
    return <p className="py-8 text-center text-sm text-muted-foreground">{tc('Loading tools & data sources…')}</p>;
  }
  if (isError || !data) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {error instanceof Error ? error.message : tc('Could not load tools.')}
      </p>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Webhook className="size-4" />
            {tc('Webhook Tools ({count})', { count: data.tools.length })}
          </CardTitle>
          <CardDescription>
            {tc('Signed HTTP tools that the tenant AI can call on behalf of permitted roles.')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {data.tools.length === 0 ? (
            <p className="rounded-xl border bg-muted/20 p-4 text-center text-xs text-muted-foreground">
              {tc('No webhook tools configured yet.')}
            </p>
          ) : (
            <div className="divide-y rounded-2xl border">
              {data.tools.map((tool) => (
                <div key={tool.id} className="flex items-start justify-between gap-3 p-3 text-xs">
                  <div className="min-w-0 space-y-1">
                    <div className="font-semibold font-mono">{tool.name}</div>
                    <div className="truncate text-muted-foreground">{tool.endpointUrl}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {tc('Allowed roles: {roles}', { roles: tool.allowedRoles.join(', ') || 'none' })}
                    </div>
                  </div>
                  {canEdit && (
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      className="text-destructive shrink-0"
                      onClick={() => deleteToolMutation.mutate(tool.id)}
                      aria-label={`Delete ${tool.name}`}
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
              <div className="text-xs font-semibold">{tc('Add webhook tool')}</div>
              <Input
                value={toolName}
                onChange={(e) => setToolName(e.target.value)}
                placeholder="lookup_order"
                className="h-8 text-xs font-mono"
              />
              <Input
                value={toolUrl}
                onChange={(e) => setToolUrl(e.target.value)}
                placeholder="https://api.example.com/orders"
                className="h-8 text-xs"
              />
              <Input
                value={toolDesc}
                onChange={(e) => setToolDesc(e.target.value)}
                placeholder={tc('Tool description for the AI')}
                className="h-8 text-xs"
              />
              <Input
                value={toolRoles}
                onChange={(e) => setToolRoles(e.target.value)}
                placeholder="customer, staff, admin"
                className="h-8 text-xs font-mono"
              />
              <Button
                type="button"
                size="sm"
                disabled={createToolMutation.isPending || !toolName.trim() || !toolUrl.trim()}
                onClick={() => createToolMutation.mutate()}
              >
                <Plus className="size-3.5" />
                {tc('Create Webhook Tool')}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="size-4" />
            {tc('Database Sources ({count})', { count: data.dbSources.length })}
          </CardTitle>
          <CardDescription>
            {tc('Read-only SQL connectors with per-table and per-row RBAC isolation.')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {data.dbSources.length === 0 ? (
            <p className="rounded-xl border bg-muted/20 p-4 text-center text-xs text-muted-foreground">
              {tc('No database sources configured yet.')}
            </p>
          ) : (
            <div className="divide-y rounded-2xl border">
              {data.dbSources.map((src) => (
                <div key={src.id} className="space-y-2 p-3 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <span className="font-semibold">{src.name}</span>
                      <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-[10px] font-mono">
                        {src.driver}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      {canTest && (
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          disabled={queryDbMutation.isPending}
                          onClick={() => queryDbMutation.mutate(src.id)}
                        >
                          <Play className="size-3" />
                          {tc('Test SQL')}
                        </Button>
                      )}
                      {canEdit && (
                        <Button
                          type="button"
                          size="icon-xs"
                          variant="ghost"
                          className="text-destructive"
                          onClick={() => deleteDbMutation.mutate(src.id)}
                          aria-label={`Delete ${src.name}`}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {canTest && data.dbSources.length > 0 && (
            <div className="space-y-2 rounded-2xl border p-3">
              <div className="text-xs font-medium">{tc('SQL query tester')}</div>
              <Input
                value={testSql}
                onChange={(e) => setTestSql(e.target.value)}
                className="h-8 text-xs font-mono"
              />
              {queryOutput && (
                <pre className="max-h-36 overflow-auto rounded-xl bg-muted/40 p-2 text-[11px] font-mono">
                  {queryOutput}
                </pre>
              )}
            </div>
          )}

          {canEdit && (
            <div className="space-y-2.5 rounded-2xl border bg-muted/15 p-3">
              <div className="text-xs font-semibold">{tc('Add SQLite sandbox source')}</div>
              <Input
                value={dbName}
                onChange={(e) => setDbName(e.target.value)}
                placeholder="Sandbox DB"
                className="h-8 text-xs"
              />
              <Textarea
                rows={3}
                value={dbSql}
                onChange={(e) => setDbSql(e.target.value)}
                placeholder={tc('Optional CREATE TABLE / INSERT SQL (defaults to sample store)')}
                className="text-xs font-mono"
              />
              <Button
                type="button"
                size="sm"
                disabled={createDbMutation.isPending}
                onClick={() => createDbMutation.mutate()}
              >
                <Plus className="size-3.5" />
                {tc('Add DB Source')}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
