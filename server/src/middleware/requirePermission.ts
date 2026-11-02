import type { Request, Response, NextFunction } from 'express';
import type { SessionUser } from '../services/auth.js';
import type { Permission } from '@freellmapi/shared/user-access.js';
import { permissionGranted } from '@freellmapi/shared/permissions.js';

/**
 * Checks whether a session user holds a specific permission.
 * Primary admins and explicit wildcard grants hold all permissions. Secondary
 * administrators with explicit grant lists obey the same hierarchy as members.
 */
export function hasPermission(user: SessionUser | undefined, permission: Permission): boolean {
  return permissionGranted(user, permission);
}

/**
 * Middleware factory that enforces a specific permission on a route prefix.
 * Rejects with 403 Forbidden if the user lacks the permission.
 */
export function requirePermission(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as Request & { user?: SessionUser }).user;
    if (!hasPermission(user, permission)) {
      res.status(403).json({
        error: {
          message: `Permission denied: '${permission}' access required.`,
          type: 'forbidden',
        },
      });
      return;
    }
    next();
  };
}

