import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Building2, Shield } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from '@/components/ui/dialog';
import {
  tenantPermissionGroupVisible,
  type TenantParentPermission,
} from '../../../../shared/tenant-rbac';
import { useCustomT } from '../i18n/use-custom-t';
import { tenantPortalApi } from './api';
import { TenantAiTab } from './TenantAiTab';
import { TenantAnalyticsTab } from './TenantAnalyticsTab';
import { TenantDeskTab } from './TenantDeskTab';
import { TenantGuardrailsTab } from './TenantGuardrailsTab';
import { TenantIntegrationTab } from './TenantIntegrationTab';
import { TenantKnowledgeTab } from './TenantKnowledgeTab';
import { TenantMembersTab } from './TenantMembersTab';
import { TenantToolsTab } from './TenantToolsTab';

const TENANT_TABS: ReadonlyArray<{
  id: TenantParentPermission;
  label: string;
}> = [
  { id: 'tenant_ai_config', label: 'AI & Prompt' },
  { id: 'tenant_knowledge', label: 'Knowledge & RAG' },
  { id: 'tenant_tools', label: 'Tools & Data' },
  { id: 'tenant_guardrails', label: 'Guardrails & Output' },
  { id: 'tenant_desk', label: 'Widget & Service Desk' },
  { id: 'tenant_integration', label: 'Integration & Keys' },
  { id: 'tenant_members', label: 'Team & Permissions' },
  { id: 'tenant_analytics', label: 'Analytics & Audit' },
];

export function TenantPortalApp() {
  const tc = useCustomT();
  const [selectedTenantId, setSelectedTenantId] = useState<number | null>(null);
  const [selectedTab, setSelectedTab] = useState<TenantParentPermission | null>(null);
  const [permsOpen, setPermsOpen] = useState(false);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['tenant-portal-tenants'],
    queryFn: () => tenantPortalApi.listTenants(),
  });

  if (isLoading) {
    return <p role="status" className="py-10 text-center text-sm text-muted-foreground">{tc('Loading your assigned tenants…')}</p>;
  }
  if (isError) {
    return (
      <div role="alert" className="space-y-3 py-8 text-center">
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : tc('Could not load Tenant AI portal.')}
        </p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          {tc('Retry')}
        </Button>
      </div>
    );
  }

  const tenants = data?.tenants ?? [];
  const availableModels = data?.availableModels ?? [];

  if (tenants.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader
          title={tc('Tenant AI Portal')}
          description={tc('Dedicated workspace to configure and operate AI assistants for your assigned organizations.')}
        />
        <div className="rounded-3xl border bg-card p-8 text-center space-y-2">
          <Building2 className="mx-auto size-8 text-muted-foreground opacity-60" />
          <p className="text-sm font-medium">{tc('No Support Tenant assigned yet')}</p>
          <p className="text-xs text-muted-foreground">
            {tc('Ask the platform administrator to assign your account to a Support Tenant in Users → Tenant AI.')}
          </p>
        </div>
      </div>
    );
  }

  const activeTenant =
    tenants.find((t) => t.id === selectedTenantId) ?? tenants[0]!;

  const visibleTabs = TENANT_TABS.filter((tab) =>
    tenantPermissionGroupVisible(activeTenant.permissions, tab.id),
  );

  const activeTab =
    selectedTab && visibleTabs.some((t) => t.id === selectedTab)
      ? selectedTab
      : (visibleTabs[0]?.id ?? null);

  return (
    <div className="space-y-6">
      <PageHeader
        title={tc('Tenant AI Portal')}
        description={tc('Manage AI models, prompts, knowledge, tools, guardrails, widget, and team permissions for your assigned tenant.')}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label={tc('Active tenant')}
              value={activeTenant.id}
              onChange={(e) => {
                setSelectedTenantId(Number(e.target.value));
                setSelectedTab(null);
              }}
              className="h-8 rounded-lg border border-input bg-background px-2.5 text-xs font-medium"
            >
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.slug})
                </option>
              ))}
            </select>
            <Badge variant={activeTenant.enabled ? 'secondary' : 'destructive'}>
              {activeTenant.enabled ? tc('Active') : tc('Disabled')}
            </Badge>
            <Button type="button" size="xs" variant="outline" onClick={() => setPermsOpen(true)}>
              <Shield className="size-3.5" />
              {tc('My Permissions ({preset})', { preset: activeTenant.rolePreset })}
            </Button>
          </div>
        }
      />

      {visibleTabs.length === 0 ? (
        <div role="alert" className="rounded-2xl border p-6 text-center text-sm text-muted-foreground">
          {tc('Your membership on this tenant has no visible workspace tabs.')}
        </div>
      ) : (
        <>
          <nav
            aria-label={tc('Tenant portal sections')}
            className="inline-flex max-w-full gap-1 overflow-x-auto rounded-xl border p-1"
          >
            {visibleTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setSelectedTab(tab.id)}
                className={`shrink-0 rounded-lg px-3 py-1.5 text-xs transition-colors ${
                  activeTab === tab.id
                    ? 'bg-foreground text-background font-medium'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                }`}
              >
                {tc(tab.label)}
              </button>
            ))}
          </nav>

          <div>
            {activeTab === 'tenant_ai_config' && (
              <TenantAiTab
                tenantId={activeTenant.id}
                permissions={activeTenant.permissions}
                availableModels={availableModels}
              />
            )}
            {activeTab === 'tenant_knowledge' && (
              <TenantKnowledgeTab
                tenantId={activeTenant.id}
                permissions={activeTenant.permissions}
              />
            )}
            {activeTab === 'tenant_tools' && (
              <TenantToolsTab
                tenantId={activeTenant.id}
                permissions={activeTenant.permissions}
              />
            )}
            {activeTab === 'tenant_guardrails' && (
              <TenantGuardrailsTab
                tenantId={activeTenant.id}
                permissions={activeTenant.permissions}
              />
            )}
            {activeTab === 'tenant_desk' && (
              <TenantDeskTab
                tenantId={activeTenant.id}
                permissions={activeTenant.permissions}
              />
            )}
            {activeTab === 'tenant_integration' && (
              <TenantIntegrationTab
                tenantId={activeTenant.id}
                permissions={activeTenant.permissions}
              />
            )}
            {activeTab === 'tenant_members' && (
              <TenantMembersTab
                tenantId={activeTenant.id}
                myPermissions={activeTenant.permissions}
              />
            )}
            {activeTab === 'tenant_analytics' && (
              <TenantAnalyticsTab tenantId={activeTenant.id} />
            )}
          </div>
        </>
      )}

      <Dialog open={permsOpen} onOpenChange={setPermsOpen}>
        <DialogPopup maxWidth="max-w-lg">
          <div className="space-y-3">
            <DialogTitle>{tc('My Tenant Permissions')}</DialogTitle>
            <DialogDescription>
              {tc('Effective permissions on {tenantName} ({preset})', {
                tenantName: activeTenant.name,
                preset: activeTenant.rolePreset,
              })}
            </DialogDescription>
            <div className="flex flex-wrap gap-1.5">
              {activeTenant.permissions.map((perm) => (
                <span
                  key={perm}
                  className="rounded bg-primary/10 px-2 py-0.5 text-xs font-mono text-primary"
                >
                  {perm}
                </span>
              ))}
            </div>
            <div className="flex justify-end pt-2">
              <Button type="button" size="sm" onClick={() => setPermsOpen(false)}>
                {tc('Close')}
              </Button>
            </div>
          </div>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

export default TenantPortalApp;
