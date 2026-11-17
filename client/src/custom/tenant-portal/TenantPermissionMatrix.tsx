import {
  TENANT_PERMISSION_GROUPS,
  TENANT_ROLE_PRESETS,
  TENANT_ROLE_PRESET_META,
  inferTenantRolePreset,
  isTenantPermissionSubset,
  tenantPermissionGranted,
  toggleTenantPermissionSelection,
  type TenantPermission,
  type TenantRolePresetId,
} from '../../../../shared/tenant-rbac';
import { Button } from '@/components/ui/button';
import { useCustomT } from '../i18n/use-custom-t';

interface TenantPermissionMatrixProps {
  selected: Set<TenantPermission>;
  onChange: (next: Set<TenantPermission>) => void;
  maxAssignable?: readonly TenantPermission[];
  disabled?: boolean;
}

export function TenantPermissionMatrix({
  selected,
  onChange,
  maxAssignable = ['*'],
  disabled = false,
}: TenantPermissionMatrixProps) {
  const tc = useCustomT();
  const canGrant = (perm: TenantPermission) =>
    !disabled && tenantPermissionGranted(maxAssignable, perm);

  const selectedArray = [...selected];
  const currentPreset = inferTenantRolePreset(selectedArray);

  const applyPreset = (presetId: Exclude<TenantRolePresetId, 'custom'>) => {
    if (disabled) return;
    const presetPerms = [...TENANT_ROLE_PRESETS[presetId]];
    if (!isTenantPermissionSubset(maxAssignable, presetPerms)) return;
    onChange(new Set<TenantPermission>(presetPerms));
  };

  const selectAllAvailable = () => {
    if (disabled) return;
    if (tenantPermissionGranted(maxAssignable, '*')) {
      onChange(new Set<TenantPermission>(['*']));
      return;
    }
    const next = new Set<TenantPermission>();
    for (const group of TENANT_PERMISSION_GROUPS) {
      if (tenantPermissionGranted(maxAssignable, group.key)) {
        next.add(group.key);
      } else {
        for (const child of group.children) {
          if (tenantPermissionGranted(maxAssignable, child.key)) {
            next.add(child.key);
          }
        }
      }
    }
    onChange(next);
  };

  const subject = selectedArray;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            {tc('Role presets')}
          </span>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={disabled}
              onClick={selectAllAvailable}
            >
              {tc('Select all available')}
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={disabled}
              onClick={() => onChange(new Set())}
            >
              {tc('Clear all')}
            </Button>
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          {TENANT_ROLE_PRESET_META.map((preset) => {
            const presetPerms = [...TENANT_ROLE_PRESETS[preset.id]];
            const assignable = isTenantPermissionSubset(maxAssignable, presetPerms);
            const active = currentPreset === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                disabled={disabled || !assignable}
                onClick={() => applyPreset(preset.id)}
                className={`rounded-xl border p-2.5 text-left transition-colors ${
                  active
                    ? 'border-primary bg-primary/10 text-foreground'
                    : 'hover:bg-muted/50 text-foreground'
                } disabled:opacity-45 disabled:cursor-not-allowed`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold">{tc(preset.title)}</span>
                  {active && (
                    <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] text-primary-foreground">
                      {tc('Selected')}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">{tc(preset.description)}</p>
              </button>
            );
          })}
        </div>
      </div>

      <label className="flex items-center gap-2 rounded-xl border bg-muted/20 px-3 py-2 text-xs font-medium">
        <input
          type="checkbox"
          checked={selected.has('*')}
          disabled={!canGrant('*')}
          onChange={() => onChange(toggleTenantPermissionSelection(selected, '*'))}
        />
        <span>{tc('Full Tenant Owner access (all current and future tenant capabilities)')}</span>
      </label>

      <div className="space-y-3">
        {TENANT_PERMISSION_GROUPS.map((group) => {
          const allChildrenGranted = group.children.every((c) =>
            tenantPermissionGranted(subject, c.key),
          );
          const groupChecked = tenantPermissionGranted(subject, group.key) || allChildrenGranted;
          return (
            <fieldset key={group.key} className="rounded-2xl border p-3">
              <legend className="px-1 text-xs font-semibold">{tc(group.title)}</legend>
              <label className="flex items-start gap-2 border-b pb-2.5 text-xs">
                <input
                  type="checkbox"
                  checked={groupChecked}
                  disabled={!canGrant(group.key)}
                  onChange={() => onChange(toggleTenantPermissionSelection(selected, group.key))}
                />
                <span>
                  <span className="font-medium">{tc('All actions in this group')}</span>
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">
                    {tc(group.description)}
                  </span>
                </span>
              </label>
              <div className="grid gap-2.5 pt-2.5 sm:grid-cols-2">
                {group.children.map((child) => (
                  <label key={child.key} className="flex items-start gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={tenantPermissionGranted(subject, child.key)}
                      disabled={!canGrant(child.key)}
                      onChange={() => onChange(toggleTenantPermissionSelection(selected, child.key))}
                    />
                    <span>
                      <span className="font-medium">{tc(child.title)}</span>
                      <span className="mt-0.5 block text-[11px] text-muted-foreground">
                        {tc(child.description)}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          );
        })}
      </div>
    </div>
  );
}
