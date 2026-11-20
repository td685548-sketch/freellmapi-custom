import { PERMISSION_GROUPS } from '@freellmapi/shared/permissions.js';
import type { KbChunk } from '../types.js';

/**
 * Generated straight from PERMISSION_GROUPS — the single source of truth for
 * permission names, hierarchy and descriptions — so it can never drift.
 */
export function buildPermissionChunks(): KbChunk[] {
  const chunks: KbChunk[] = [];
  for (const group of PERMISSION_GROUPS) {
    const childLines = group.children.map((c) => `- \`${c.key}\` — ${c.title}: ${c.description}`);
    chunks.push({
      id: `perm:${group.key}`,
      source: 'permission',
      title: `Permission group: ${group.title} (${group.key})`,
      titleVi: `Nhóm quyền: ${group.title} (${group.key})`,
      text: `Permission group \`${group.key}\` — ${group.title}. ${group.description} Holding the parent grants every child below; a child alone grants only that action.\n${childLines.join('\n')}\nGrant or revoke permissions under Users & Roles (/users) — you can only assign permissions you hold yourself.`,
      textVi: `Nhóm quyền \`${group.key}\` — ${group.title}. Có quyền cha thì có toàn bộ quyền con bên dưới; chỉ có quyền con thì chỉ làm được đúng hành động đó. Cấp hoặc thu hồi tại Người dùng & Vai trò (/users) — bạn chỉ cấp được quyền mà chính bạn đang có.`,
      path: '/users',
      tags: ['permission', 'quyen', 'phan quyen', 'rbac', group.key, ...group.children.map((c) => c.key)],
    });
    for (const child of group.children) {
      chunks.push({
        id: `perm:${child.key}`,
        source: 'permission',
        title: `Permission: ${child.title} (${child.key})`,
        titleVi: `Quyền: ${child.title} (${child.key})`,
        text: `Permission \`${child.key}\` (part of ${group.title}, parent \`${group.key}\`): ${child.description} Manage it under Users & Roles (/users).`,
        textVi: `Quyền \`${child.key}\` (thuộc nhóm ${group.title}, quyền cha \`${group.key}\`): ${child.description} Quản lý tại Người dùng & Vai trò (/users).`,
        path: '/users',
        tags: ['permission', 'quyen', 'phan quyen', child.key, group.key],
      });
    }
  }
  return chunks;
}
