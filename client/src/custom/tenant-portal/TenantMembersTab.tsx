import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Shield, Trash2, UserPlus, Users } from 'lucide-react';
import { ConfirmButton } from '@/components/confirm-button';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { toast } from '@/lib/toast';
import {
  inferTenantRolePreset,
  isTenantPermissionSubset,
  tenantPermissionGranted,
  type TenantMemberRecord,
  type TenantPermission,
} from '../../../../shared/tenant-rbac';
import { useCustomT } from '../i18n/use-custom-t';
import { tenantPortalApi } from './api';
import { TenantPermissionMatrix } from './TenantPermissionMatrix';

export function TenantMembersTab({
  tenantId,
  myPermissions,
}: {
  tenantId: number;
  myPermissions: readonly TenantPermission[];
}) {
  const tc = useCustomT();
  const queryClient = useQueryClient();
  const canManage = tenantPermissionGranted(myPermissions, 'manage_tenant_members');

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['tenant-portal-members', tenantId],
    queryFn: () => tenantPortalApi.listMembers(tenantId),
  });

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingMember, setEditingMember] = useState<TenantMemberRecord | null>(null);
  const [emailInput, setEmailInput] = useState('');
  const [selectedPerms, setSelectedPerms] = useState<Set<TenantPermission>>(new Set(['view_tenant_ai']));

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['tenant-portal-members', tenantId] });
  };

  const openAddDialog = () => {
    setEditingMember(null);
    setEmailInput('');
    setSelectedPerms(new Set(['view_tenant_ai']));
    setEditorOpen(true);
  };

  const openEditDialog = (member: TenantMemberRecord) => {
    setEditingMember(member);
    setEmailInput(member.email);
    setSelectedPerms(new Set(member.permissions));
    setEditorOpen(true);
  };

  const saveMutation = useMutation({
    mutationFn: () => {
      const permissions = [...selectedPerms];
      const rolePreset = inferTenantRolePreset(permissions);
      if (editingMember) {
        return tenantPortalApi.updateMember(tenantId, editingMember.userId, {
          rolePreset,
          permissions,
        });
      }
      return tenantPortalApi.addMember(tenantId, {
        email: emailInput.trim(),
        rolePreset,
        permissions,
      });
    },
    onSuccess: () => {
      toast.success(editingMember ? tc('Tenant member updated') : tc('Tenant member added'));
      setEditorOpen(false);
      refresh();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const removeMutation = useMutation({
    mutationFn: (userId: number) => tenantPortalApi.removeMember(tenantId, userId),
    onSuccess: () => {
      toast.success(tc('Tenant member removed'));
      refresh();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  if (isLoading) {
    return <p className="py-8 text-center text-sm text-muted-foreground">{tc('Loading team members…')}</p>;
  }
  if (isError || !data) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {error instanceof Error ? error.message : tc('Could not load team members.')}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Users className="size-4" />
              {tc('Tenant Team ({count})', { count: data.members.length })}
            </CardTitle>
            <CardDescription>
              {tc('Assign existing accounts to collaborate on this tenant. Delegated admins can grant only permissions they hold.')}
            </CardDescription>
          </div>
          {canManage && (
            <Button type="button" size="sm" onClick={openAddDialog}>
              <UserPlus className="size-3.5" />
              {tc('Add Team Member')}
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {data.members.length === 0 ? (
            <p className="rounded-xl border bg-muted/20 p-5 text-center text-xs text-muted-foreground">
              {tc('No tenant members assigned yet.')}
            </p>
          ) : (
            <div className="divide-y rounded-2xl border">
              {data.members.map((member) => {
                const withinScope = isTenantPermissionSubset(myPermissions, member.permissions);
                const rowLocked =
                  !canManage || member.isSelf || member.isPrimary || !withinScope;
                return (
                  <div
                    key={member.userId}
                    className="flex flex-wrap items-center justify-between gap-3 p-3.5"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-semibold">{member.email}</span>
                        <span className="rounded-full border bg-muted/40 px-2 py-0.5 text-[10px] font-medium">
                          {member.rolePreset}
                        </span>
                        {member.isSelf && (
                          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                            {tc('You')}
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {member.permissions.map((perm) => (
                          <span
                            key={perm}
                            className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-mono text-primary"
                          >
                            {perm}
                          </span>
                        ))}
                      </div>
                    </div>

                    {canManage && (
                      <div className="flex items-center gap-2 shrink-0">
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          disabled={rowLocked}
                          onClick={() => openEditDialog(member)}
                          title={
                            !withinScope
                              ? tc('Cannot edit a member with broader tenant permissions than your own.')
                              : undefined
                          }
                        >
                          <Shield className="size-3" />
                          {tc('Edit')}
                        </Button>
                        <ConfirmButton
                          size="xs"
                          variant="ghost"
                          className="text-destructive"
                          disabled={rowLocked || removeMutation.isPending}
                          confirmLabel={tc('Confirm remove')}
                          onConfirm={() => removeMutation.mutate(member.userId)}
                        >
                          <Trash2 className="size-3" />
                          {tc('Remove')}
                        </ConfirmButton>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogPopup maxWidth="max-w-3xl">
          <div className="space-y-4">
            <div>
              <DialogTitle>
                {editingMember ? tc('Edit Tenant Member') : tc('Add Tenant Member')}
              </DialogTitle>
              <DialogDescription>
                {tc('Grant only permissions you hold on this tenant. Wildcard (*) requires Tenant Owner access.')}
              </DialogDescription>
            </div>

            {!editingMember && (
              <div className="space-y-1.5">
                <label htmlFor="member-email" className="text-xs font-medium">
                  {tc('Existing user email')}
                </label>
                <Input
                  id="member-email"
                  type="email"
                  value={emailInput}
                  onChange={(e) => setEmailInput(e.target.value)}
                  placeholder="partner-staff@example.com"
                />
              </div>
            )}

            <div className="max-h-[50vh] overflow-y-auto pr-1">
              <TenantPermissionMatrix
                selected={selectedPerms}
                onChange={setSelectedPerms}
                maxAssignable={myPermissions}
              />
            </div>

            <div className="flex justify-end gap-2 border-t pt-3">
              <Button type="button" variant="ghost" size="sm" onClick={() => setEditorOpen(false)}>
                {tc('Cancel')}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={
                  saveMutation.isPending ||
                  selectedPerms.size === 0 ||
                  (!editingMember && !emailInput.trim())
                }
                onClick={() => saveMutation.mutate()}
              >
                {saveMutation.isPending ? tc('Saving…') : tc('Save Member')}
              </Button>
            </div>
          </div>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
