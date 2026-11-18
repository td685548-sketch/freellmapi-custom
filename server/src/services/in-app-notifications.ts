import { permissionGranted, type Permission } from '@freellmapi/shared/permissions.js';
import { getDb } from '../db/index.js';

export type NotificationCategory =
  | 'provider_health'
  | 'registration'
  | 'quota'
  | 'security'
  | 'system';

export type NotificationSeverity = 'info' | 'warning' | 'critical';

export interface InAppNotification {
  id: number;
  userId: number;
  category: NotificationCategory;
  severity: NotificationSeverity;
  title: string;
  body: string;
  actionUrl: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface CreateNotificationInput {
  userId: number;
  category: NotificationCategory;
  severity?: NotificationSeverity;
  title: string;
  body: string;
  actionUrl?: string | null;
  dedupeKey?: string | null;
}

const MAX_PER_USER = 200;
const READ_RETENTION_DAYS = 30;
let lastGlobalPruneAt = 0;

function hasNotificationsTable(): boolean {
  try {
    return Boolean(
      getDb()
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'custom_notifications'")
        .get(),
    );
  } catch {
    return false;
  }
}

function pruneForUser(userId: number): void {
  const db = getDb();
  const now = Date.now();
  if (now - lastGlobalPruneAt > 60 * 60 * 1000) {
    lastGlobalPruneAt = now;
    const cutoff = new Date(now - READ_RETENTION_DAYS * 86_400_000).toISOString();
    db.prepare('DELETE FROM custom_notifications WHERE read_at IS NOT NULL AND created_at < ?').run(cutoff);
  }
  const countRow = db
    .prepare('SELECT COUNT(*) AS count FROM custom_notifications WHERE user_id = ?')
    .get(userId) as { count: number } | undefined;
  if ((countRow?.count ?? 0) > MAX_PER_USER) {
    db.prepare(
      `DELETE FROM custom_notifications
        WHERE user_id = ?
          AND id NOT IN (
            SELECT id FROM custom_notifications
             WHERE user_id = ?
             ORDER BY id DESC
             LIMIT ?
          )`,
    ).run(userId, userId, MAX_PER_USER);
  }
}

export function createUserNotification(input: CreateNotificationInput): number | null {
  if (!hasNotificationsTable()) return null;
  try {
    const db = getDb();
    const title = input.title.trim().slice(0, 240);
    const body = input.body.trim().slice(0, 1200);
    if (!title || !body) return null;
    const actionUrl = input.actionUrl?.trim() ? input.actionUrl.trim().slice(0, 300) : null;
    const dedupeKey = input.dedupeKey?.trim() ? input.dedupeKey.trim().slice(0, 200) : null;
    const severity: NotificationSeverity = input.severity ?? 'info';
    const createdAt = new Date().toISOString();

    const result = db
      .prepare(
        `INSERT OR IGNORE INTO custom_notifications (
           user_id, category, severity, title, body, action_url, dedupe_key, created_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.userId,
        input.category,
        severity,
        title,
        body,
        actionUrl,
        dedupeKey,
        createdAt,
      );

    if (result.changes === 0) return null;
    pruneForUser(input.userId);
    return Number(result.lastInsertRowid);
  } catch {
    return null;
  }
}

export function notifyOperatorsWithPermission(
  permission: Permission,
  notification: Omit<CreateNotificationInput, 'userId'>,
): number {
  if (!hasNotificationsTable()) return 0;
  try {
    const db = getDb();
    const rows = db
      .prepare('SELECT id, role, is_primary, permissions FROM users')
      .all() as Array<{
      id: number;
      role: 'admin' | 'member';
      is_primary: number;
      permissions: string | null;
    }>;

    let delivered = 0;
    for (const row of rows) {
      let parsedPermissions: Permission[] | undefined;
      if (typeof row.permissions === 'string' && row.permissions.trim()) {
        try {
          const raw = JSON.parse(row.permissions);
          if (Array.isArray(raw)) parsedPermissions = raw as Permission[];
        } catch {
          parsedPermissions = undefined;
        }
      }
      const subject = {
        role: row.role,
        isPrimary: Boolean(row.is_primary),
        permissions: parsedPermissions,
      };
      if (permissionGranted(subject, permission)) {
        const id = createUserNotification({ ...notification, userId: row.id });
        if (id !== null) delivered++;
      }
    }
    return delivered;
  } catch {
    return 0;
  }
}

export function listUserNotifications(
  userId: number,
  limit = 40,
): { notifications: InAppNotification[]; unreadCount: number } {
  if (!hasNotificationsTable()) {
    return { notifications: [], unreadCount: 0 };
  }
  const db = getDb();
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const rows = db
    .prepare(
      `SELECT
         id,
         user_id AS userId,
         category,
         severity,
         title,
         body,
         action_url AS actionUrl,
         read_at AS readAt,
         created_at AS createdAt
       FROM custom_notifications
       WHERE user_id = ?
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(userId, safeLimit) as InAppNotification[];

  const unreadRow = db
    .prepare('SELECT COUNT(*) AS count FROM custom_notifications WHERE user_id = ? AND read_at IS NULL')
    .get(userId) as { count: number } | undefined;

  return {
    notifications: rows,
    unreadCount: unreadRow?.count ?? 0,
  };
}

export function markNotificationRead(userId: number, notificationId: number): { updated: boolean; unreadCount: number } {
  if (!hasNotificationsTable()) return { updated: false, unreadCount: 0 };
  const db = getDb();
  const res = db
    .prepare(
      `UPDATE custom_notifications
          SET read_at = COALESCE(read_at, ?)
        WHERE id = ? AND user_id = ?`,
    )
    .run(new Date().toISOString(), notificationId, userId);

  const unreadRow = db
    .prepare('SELECT COUNT(*) AS count FROM custom_notifications WHERE user_id = ? AND read_at IS NULL')
    .get(userId) as { count: number } | undefined;

  return {
    updated: res.changes > 0,
    unreadCount: unreadRow?.count ?? 0,
  };
}

export function markAllNotificationsRead(userId: number): { updatedCount: number; unreadCount: number } {
  if (!hasNotificationsTable()) return { updatedCount: 0, unreadCount: 0 };
  const db = getDb();
  const res = db
    .prepare(
      `UPDATE custom_notifications
          SET read_at = ?
        WHERE user_id = ? AND read_at IS NULL`,
    )
    .run(new Date().toISOString(), userId);

  return {
    updatedCount: res.changes,
    unreadCount: 0,
  };
}

export function clearReadNotifications(userId: number): { deletedCount: number; unreadCount: number } {
  if (!hasNotificationsTable()) return { deletedCount: 0, unreadCount: 0 };
  const db = getDb();
  const res = db
    .prepare('DELETE FROM custom_notifications WHERE user_id = ? AND read_at IS NOT NULL')
    .run(userId);

  const unreadRow = db
    .prepare('SELECT COUNT(*) AS count FROM custom_notifications WHERE user_id = ? AND read_at IS NULL')
    .get(userId) as { count: number } | undefined;

  return {
    deletedCount: res.changes,
    unreadCount: unreadRow?.count ?? 0,
  };
}

/** Tests only: resets periodic prune timer. */
export function resetNotificationPruneForTests(): void {
  lastGlobalPruneAt = 0;
}
