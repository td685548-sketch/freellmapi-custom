import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Crown, Trash2 } from 'lucide-react';
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { toast } from '@/lib/toast';
import type { AdminUser } from '../../../shared/user-access';
import {
  inferTenantRolePreset,
  type TenantPermission,
} from '../../../shared/tenant-rbac';
import { useCustomT } from './i18n/use-custom-t';
import { useUserSession } from './use-session';
import { tenantAdminApi } from './tenant-portal/api';
import { TenantPermissionMatrix } from './tenant-portal/TenantPermissionMatrix';

interface TenantAccessDialogProps {
  user: AdminUser | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

export function TenantAccessDialog(props: TenantAccessDialogProps) {
  if (!props.user || !props.open) return null;
  return <TenantAccessEditor key={props.user.id} {...props} user={props.user} />;
}

function TenantAccessEditor({
  user,
  open,
  onOpenChange,
  onSuccess,
}: Omit<TenantAccessDialogProps, 'user'> & { user: AdminUser }) {
  const tc = useCustomT();
  const queryClient = useQueryClient();
  const { hasPermission } = useUserSession();
  const [selectedTenantId, setSelectedTenantId] = useState<number | null>(null);
  const [draftSelection, setDraftSelection] = useState<{
    tenantId: number;
    permissions: Set<TenantPermission>;
  } | null>(null);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['admin-tenant-memberships', user.id],
    queryFn: () => tenantAdminApi.getUserMemberships(user.id),
    enabled: open,
  });

  const tenants = data?.tenants ?? [];
  const memberships = data?.memberships ?? [];
  const membershipByTenant = new Map(memberships.map((m) => [m.tenantId, m]));

  const activeTenantId =
    selectedTenantId && tenants.some((t) => t.id === selectedTenantId)
      ? selectedTenantId
      : (memberships[0]?.tenantId ?? tenants[0]?.id ?? null);

  const currentMembership = activeTenantId ? membershipByTenant.get(activeTenantId) : undefined;
  const selectedPermissions =
    draftSelection && draftSelection.tenantId === activeTenantId
      ? draftSelection.permissions
      : new Set<TenantPermission>(currentMembership?.permissions ?? []);

  const canWrite =
    hasPermission('*') ||
    hasPermission('manage_x_gateway') ||
    (hasPermission('use_x_gateway') && hasPermission('edit_x_settings')) ||
    hasPermission('edit_user_permissions');

  const locked = user.isPrimary || user.isSelf || !canWrite;

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['admin-tenant-memberships', user.id] });
    queryClient.invalidateQueries({ queryKey: ['user-session'] });
    onSuccess?.();
  };

  const saveMutation = useMutation({
    mutationFn: () => {
      if (!activeTenantId) throw new Error('Select a tenant first.');
      const permissions = [...selectedPermissions];
      return tenantAdminApi.upsertUserMembership(activeTenantId, user.id, {
        rolePreset: inferTenantRolePreset(permissions),
        permissions,
      });
    },
    onSuccess: () => {
      toast.success(tc('Tenant permissions saved'));
      setDraftSelection(null);
      refresh();
    },
    onError: (err: Error) => {
      toast.error(err.message || tc('Failed to save tenant permissions'));
    },
  });

  const revokeMutation = useMutation({
    mutationFn: () => {
      if (!activeTenantId) throw new Error('Select a tenant first.');
      return tenantAdminApi.removeUserMembership(activeTenantId, user.id);
    },
    onSuccess: () => {
      toast.success(tc('Tenant access revoked'));
      setDraftSelection(null);
      refresh();
    },
    onError: (err: Error) => {
      toast.error(err.message || tc('Failed to revoke tenant access'));
    },
  });

  const busy = saveMutation.isPending || revokeMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup maxWidth="max-w-3xl">
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <Building2 className="size-5" />
            <div>
              <DialogTitle>{tc('Tenant AI Permissions')}</DialogTitle>
              <DialogDescription>
                {tc('Assign Support Tenants and per-tenant AI permissions for')}{' '}
                <strong>{user.email}</strong>
              </DialogDescription>
            </div>
          </div>

          {user.isPrimary ? (
            <p className="flex items-center gap-2 rounded-xl border p-3 text-xs">
              <Crown className="size-4" />
              {tc('Primary Admin always has full access to every Support Tenant.')}
            </p>
          ) : user.isSelf ? (
            <p className="text-xs text-muted-foreground">
              {tc('You cannot modify your own tenant membership here.')}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {tc('Assigned users can open /tenant-portal to adjust AI settings, knowledge, tools, guardrails, and service desk strictly within the selected tenant.')}
            </p>
          )}

          {isLoading ? (
            <p className="py-6 text-center text-xs text-muted-foreground">{tc('Loading tenants…')}</p>
          ) : isError ? (
            <p role="alert" className="text-xs text-destructive">
              {error instanceof Error ? error.message : tc('Could not load tenants.')}
            </p>
          ) : tenants.length === 0 ? (
            <div className="rounded-2xl border bg-muted/20 p-5 text-center text-xs text-muted-foreground">
              {tc('No Support Tenants exist yet. Create one in Thruline → Support Gateway first.')}
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-[220px_1fr]">
              <div className="space-y-1.5 rounded-2xl border p-2">
                <div className="px-2 py-1 text-[11px] font-semibold text-muted-foreground">
                  {tc('Support Tenants ({count})', { count: tenants.length })}
                </div>
                {tenants.map((t) => {
                  const assigned = membershipByTenant.get(t.id);
                  const active = t.id === activeTenantId;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => {
                        setSelectedTenantId(t.id);
                        setDraftSelection(null);
                      }}
                      className={`w-full rounded-xl px-2.5 py-2 text-left text-xs transition-colors ${
                        active
                          ? 'bg-primary text-primary-foreground'
                          : 'hover:bg-muted/60 text-foreground'
                      }`}
                    >
                      <div className="font-medium truncate">{t.name}</div>
                      <div
                        className={`text-[10px] truncate ${
                          active ? 'text-primary-foreground/80' : 'text-muted-foreground'
                        }`}
                      >
                        {assigned ? assigned.rolePreset : tc('Not assigned')}
                      </div>
                    </button>
                  );
                })}
              </div>

              {activeTenantId !== null && (
                <div className="max-h-[52vh] space-y-3 overflow-y-auto pr-1">
                  <TenantPermissionMatrix
                    selected={selectedPermissions}
                    onChange={(next) =>
                      setDraftSelection({ tenantId: activeTenantId, permissions: next })
                    }
                    disabled={locked || busy}
                  />
                </div>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
            <div>
              {!locked && currentMembership && (
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => revokeMutation.mutate()}
                >
                  <Trash2 className="size-3.5" />
                  {tc('Revoke tenant access')}
                </Button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                {tc('Close')}
              </Button>
              {!locked && activeTenantId !== null && (
                <Button
                  size="sm"
                  disabled={busy || selectedPermissions.size === 0}
                  onClick={() => saveMutation.mutate()}
                >
                  {saveMutation.isPending ? tc('Saving…') : tc('Save Tenant Access')}
                </Button>
              )}
            </div>
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
